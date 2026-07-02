const DEFAULT_TIMEOUT_MS = 15_000;

const PLACEHOLDER_KEYS = new Set([
  '',
  'your_ai_relay_key_here',
  'your_api_key_here',
]);

// --- Circuit breaker state ---
let consecutiveFailures = 0;
let circuitOpenUntil = 0;
const CIRCUIT_BREAK_THRESHOLD = 3;
const CIRCUIT_BREAK_MS = 5 * 60 * 1000;         // 普通失败：熔断 5 分钟
const SUSPENDED_BREAK_MS = 30 * 60 * 1000;       // key suspended：熔断 30 分钟

export function getAIConfigStatus() {
  const enabled = process.env.AI_ENABLED === 'true';
  const apiKey = String(process.env.AI_API_KEY || '').trim();

  if (!enabled) {
    return { ok: false, reason: 'AI_ENABLED 不是 true' };
  }

  if (!apiKey || PLACEHOLDER_KEYS.has(apiKey.toLowerCase())) {
    return { ok: false, reason: 'AI_API_KEY 未配置真实密钥' };
  }

  return { ok: true, reason: '' };
}

export function isAIEnabled() {
  return getAIConfigStatus().ok;
}

export function getAICircuitStatus() {
  const now = Date.now();
  return {
    open: now < circuitOpenUntil,
    remainingMs: Math.max(0, circuitOpenUntil - now),
    failures: consecutiveFailures,
  };
}

function getAIConfig() {
  const baseUrl = (process.env.AI_BASE_URL || 'https://api.137280.xyz/v1').replace(/\/+$/, '');
  return {
    baseUrl,
    apiKey: process.env.AI_API_KEY,
    model: process.env.AI_MODEL || 'gemini-2.5-flash',
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

function extractJsonObject(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

function compactText(text, limit = 500) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function isSuspendedError(status, text) {
  return status === 403 && /suspended/i.test(String(text || ''));
}

async function postChatCompletion(config, messages, temperature, { responseFormat = true } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const body = {
      model: config.model,
      messages,
      temperature,
    };
    if (responseFormat) body.response_format = { type: 'json_object' };

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await response.text().catch(() => '');
    if (!response.ok) {
      // 只有可能是 response_format 导致的错误才标记为 retryable
      // 403(权限)/429(限流)/5xx(过载) 重试无意义
      const retryable = responseFormat && response.status < 403;
      return {
        ok: false,
        status: response.status,
        text,
        retryable,
      };
    }

    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, status: 200, text, retryable: responseFormat };
    }
  } catch (error) {
    // AbortError(超时) 不重试
    return {
      ok: false,
      error,
      retryable: false,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestAIJson(messages, { temperature = 0.4 } = {}) {
  if (!isAIEnabled()) return null;

  // 熔断检查
  if (Date.now() < circuitOpenUntil) return null;

  const config = getAIConfig();
  let result = await postChatCompletion(config, messages, temperature, { responseFormat: true });

  if (!result.ok && result.retryable) {
    const reason = result.error
      ? `${result.error.name}: ${result.error.message}`
      : `${result.status || 'unknown'} ${compactText(result.text)}`;
    console.warn('[AI] request failed with response_format, retrying without it:', reason);
    result = await postChatCompletion(config, messages, temperature, { responseFormat: false });
  }

  if (!result.ok) {
    consecutiveFailures++;

    if (result.error) {
      console.error('[AI] request error:', `${result.error.name}: ${result.error.message}`);
    } else {
      console.error('[AI] request failed:', result.status || 'unknown', compactText(result.text));
    }

    // key suspended → 长熔断
    if (isSuspendedError(result.status, result.text)) {
      circuitOpenUntil = Date.now() + SUSPENDED_BREAK_MS;
      console.warn(`[AI] API key suspended, circuit breaker open for 30 minutes`);
    } else if (consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
      circuitOpenUntil = Date.now() + CIRCUIT_BREAK_MS;
      console.warn(`[AI] ${consecutiveFailures} consecutive failures, circuit breaker open for 5 minutes`);
    }

    return null;
  }

  // 成功，重置熔断计数
  consecutiveFailures = 0;

  const content = result.data?.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(content);
  if (!parsed) console.error('[AI] failed to parse JSON response:', compactText(content));
  return parsed;
}
