const DEFAULT_TIMEOUT_MS = 15_000;
const PLACEHOLDER_KEYS = new Set([
  '',
  'your_ai_relay_key_here',
  'your_api_key_here',
]);
const BREAKER_FEATURES = new Set(['general', 'voice-control', 'ai-music', 'playlist', 'radio']);

const breakers = new Map();
let breakerConfigSignature = null;
const CIRCUIT_BREAK_THRESHOLD = 3;
const CIRCUIT_BREAK_MS = 5 * 60 * 1000;
const SUSPENDED_BREAK_MS = 30 * 60 * 1000;

function normalizeFeature(value) {
  const feature = String(value || 'general').trim().toLowerCase();
  return BREAKER_FEATURES.has(feature) ? feature : 'general';
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || host === '0.0.0.0' || host === '::1' || host === '::'
    || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
    || /^::ffff:127\./.test(host) || /^::ffff:10\./.test(host)
    || /^::ffff:192\.168\./.test(host) || host === '::ffff:7f00:1') return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const [, a, b] = ipv4.map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}

export function validateAIEndpoint(value = process.env.AI_BASE_URL) {
  const raw = String(value || '').trim();
  if (!raw) throw new TypeError('AI endpoint is required');

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('AI endpoint must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || isPrivateHostname(parsed.hostname)) {
    throw new TypeError('AI endpoint must be a public HTTPS URL without credentials or query data');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function rawConfig() {
  return {
    enabled: process.env.AI_ENABLED === 'true',
    apiKey: String(process.env.AI_API_KEY || '').trim(),
    baseUrl: String(process.env.AI_BASE_URL || '').trim(),
    model: String(process.env.AI_MODEL || 'gemini-2.5-flash').trim(),
    timeoutMs: Number(process.env.AI_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
  };
}

function syncBreakerConfig() {
  const config = rawConfig();
  const signature = JSON.stringify({
    enabled: config.enabled,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    model: config.model,
    timeoutMs: config.timeoutMs,
  });
  if (breakerConfigSignature !== signature) {
    breakers.clear();
    breakerConfigSignature = signature;
  }
  return config;
}

function breakerState(feature) {
  const normalized = normalizeFeature(feature);
  if (!breakers.has(normalized)) breakers.set(normalized, { consecutiveFailures: 0, openUntil: 0 });
  return breakers.get(normalized);
}

function resetBreaker(feature) {
  const state = breakerState(feature);
  state.consecutiveFailures = 0;
  state.openUntil = 0;
}

function recordFailure(feature, result) {
  const state = breakerState(feature);
  state.consecutiveFailures += 1;
  if (isSuspendedError(result.status, result.text)) {
    state.openUntil = Date.now() + SUSPENDED_BREAK_MS;
  } else if (state.consecutiveFailures >= CIRCUIT_BREAK_THRESHOLD) {
    state.openUntil = Date.now() + CIRCUIT_BREAK_MS;
  }
}

function isSuspendedError(status, text) {
  return status === 403 && /suspended/i.test(String(text || ''));
}

function isAbortOrTimeout(result, signal) {
  if (signal?.aborted || result?.aborted || result?.timedOut) return true;
  const name = String(result?.error?.name || '');
  return name === 'AbortError' || name === 'TimeoutError';
}

export function getAIConfigStatus() {
  const config = syncBreakerConfig();
  if (!config.enabled) {
    return { ok: false, reason: 'AI_ENABLED 不是 true' };
  }
  if (!config.apiKey || PLACEHOLDER_KEYS.has(config.apiKey.toLowerCase())) {
    return { ok: false, reason: 'AI_API_KEY 未配置真实密钥' };
  }
  if (!config.model || PLACEHOLDER_KEYS.has(config.model.toLowerCase())) {
    return { ok: false, reason: 'AI_MODEL 未配置有效模型' };
  }
  try {
    validateAIEndpoint(config.baseUrl);
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  return { ok: true, reason: '' };
}

export function isAIEnabled() {
  return getAIConfigStatus().ok;
}

export function getAICircuitStatus(feature = 'general') {
  syncBreakerConfig();
  const state = breakerState(feature);
  const now = Date.now();
  return {
    feature: normalizeFeature(feature),
    open: now < state.openUntil,
    remainingMs: Math.max(0, state.openUntil - now),
    failures: state.consecutiveFailures,
  };
}

export function resetAICircuitBreakers() {
  breakers.clear();
}

function getAIConfig() {
  const config = syncBreakerConfig();
  return {
    baseUrl: validateAIEndpoint(config.baseUrl),
    apiKey: config.apiKey,
    model: config.model,
    timeoutMs: Math.max(1_000, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS),
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

function isResponseFormatCompatibilityError(status, text) {
  if (![400, 422].includes(Number(status))) return false;
  const body = String(text || '').toLowerCase();
  return /response[_ ]?format|json[_ -]?object|structured\s+output|unknown\s+(?:field|parameter).*(?:json|response)|unsupported.*(?:json|response)/i.test(body);
}

async function postChatCompletion(config, messages, temperature, {
  responseFormat = true,
  signal,
  request = globalThis.fetch,
} = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    const error = new Error('AI request timeout');
    error.name = 'TimeoutError';
    controller.abort(error);
  }, config.timeoutMs);

  try {
    if (typeof request !== 'function') throw new TypeError('AI request function is unavailable');
    const body = {
      model: config.model,
      messages,
      temperature,
    };
    if (responseFormat) body.response_format = { type: 'json_object' };

    const response = await request(`${config.baseUrl}/chat/completions`, {
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
      return {
        ok: false,
        status: response.status,
        text,
        retryable: responseFormat && isResponseFormatCompatibilityError(response.status, text),
      };
    }

    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false, status: 200, text, retryable: false, invalidJson: true };
    }
  } catch (error) {
    return {
      ok: false,
      error,
      aborted: signal?.aborted || error?.name === 'AbortError',
      timedOut,
      retryable: false,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function requestAIJson(messages, {
  temperature = 0.4,
  timeoutMs,
  signal,
  responseFormat = true,
  feature = 'general',
  request = globalThis.fetch,
} = {}) {
  const normalizedFeature = normalizeFeature(feature);
  if (!isAIEnabled()) return null;

  const circuit = getAICircuitStatus(normalizedFeature);
  if (circuit.open) return null;

  let config;
  try {
    config = getAIConfig();
  } catch {
    return null;
  }
  if (Number.isFinite(timeoutMs)) config.timeoutMs = Math.max(1_000, timeoutMs);

  let result = await postChatCompletion(config, messages, temperature, {
    responseFormat,
    signal,
    request,
  });

  if (responseFormat && !result.ok && result.retryable && !isAbortOrTimeout(result, signal)) {
    const reason = result.error
      ? `${result.error.name}: ${result.error.message}`
      : `${result.status || 'unknown'} ${compactText(result.text)}`;
    console.warn('[AI] request failed with response_format, retrying without it:', reason);
    result = await postChatCompletion(config, messages, temperature, {
      responseFormat: false,
      signal,
      request,
    });
  }

  if (!result.ok) {
    if (isAbortOrTimeout(result, signal)) return null;
    recordFailure(normalizedFeature, result);
    if (result.error) {
      console.error('[AI] request error:', `${result.error.name}: ${result.error.message}`);
    } else {
      console.error('[AI] request failed:', result.status || 'unknown', compactText(result.text));
    }
    const status = getAICircuitStatus(normalizedFeature);
    if (status.open) {
      console.warn(`[AI] feature=${normalizedFeature} circuit breaker open for ${Math.ceil(status.remainingMs / 60_000)} minutes`);
    }
    return null;
  }

  const content = result.data?.choices?.[0]?.message?.content;
  const parsed = extractJsonObject(typeof content === 'string' ? content : '');
  if (!parsed) {
    recordFailure(normalizedFeature, { status: 200, text: 'invalid JSON response' });
    console.error('[AI] failed to parse JSON response:', compactText(content));
    return null;
  }

  resetBreaker(normalizedFeature);
  return parsed;
}
