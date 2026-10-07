import { experimental_streamTranscribe as streamTranscribe } from 'ai';
import { createGateway } from '@ai-sdk/gateway';

const PCM_CHANNELS = 1;
const PCM_BYTES_PER_SAMPLE = 2;
const PLACEHOLDER_VALUES = new Set([
  '',
  'your_api_key_here',
  'your_token_here',
  'your_provider_here',
]);
const TOKEN_MIN_TTL_MS = 5_000;

function cleanConfigValue(value) {
  return String(value || '').trim();
}

function isPlaceholder(value) {
  return PLACEHOLDER_VALUES.has(cleanConfigValue(value).toLowerCase());
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (/^127\./.test(host) || host === '0.0.0.0' || host === '::1' || host === '[::1]'
    || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')
    || /^::ffff:127\./.test(host) || /^::ffff:10\./.test(host)
    || /^::ffff:192\.168\./.test(host) || host === '::ffff:7f00:1') return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!ipv4) return false;
  const [, a, b] = ipv4.map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254) || a === 0;
}

export function validateVoiceGatewayUrl(value, { allowEmpty = true } = {}) {
  const raw = cleanConfigValue(value);
  if (!raw) {
    if (allowEmpty) return '';
    throw new TypeError('STT Gateway URL is required');
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('STT Gateway URL must be a valid HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || parsed.search || parsed.hash || isPrivateHostname(parsed.hostname)) {
    throw new TypeError('STT Gateway URL must be a public HTTPS URL without credentials or query data');
  }
  return parsed.toString().replace(/\/+$/, '');
}

export function validateVoiceStreamUrl(value, { expectedBaseUrl = '', model = '' } = {}) {
  const raw = cleanConfigValue(value);
  if (!raw) throw new TypeError('STT stream URL is required');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new TypeError('STT stream URL must be a valid public WSS URL');
  }
  if (parsed.protocol !== 'wss:' || parsed.username || parsed.password || parsed.hash
    || isPrivateHostname(parsed.hostname)) {
    throw new TypeError('STT stream URL must be a public WSS URL without credentials or fragments');
  }
  if (!/\/transcription-model$/i.test(parsed.pathname)) {
    throw new TypeError('STT stream URL has an unexpected path');
  }
  const queryKeys = [...parsed.searchParams.keys()];
  if (queryKeys.length !== 1 || queryKeys[0] !== 'ai-model-id'
    || (model && parsed.searchParams.get('ai-model-id') !== model)) {
    throw new TypeError('STT stream URL has an unexpected model query');
  }
  if (expectedBaseUrl) {
    const base = new URL(validateVoiceGatewayUrl(expectedBaseUrl, { allowEmpty: false }));
    const expectedPath = `${base.pathname.replace(/\/+$/, '')}/transcription-model`;
    if (base.hostname !== parsed.hostname || base.port !== parsed.port
      || expectedPath !== parsed.pathname) {
      throw new TypeError('STT stream URL is outside the configured Gateway allowlist');
    }
  }
  return parsed.toString();
}

export function validateSttToken(value) {
  const token = cleanConfigValue(value);
  if (!/^vcst_[A-Za-z0-9._~-]{16,4096}$/.test(token)) {
    throw new TypeError('STT token has an invalid format');
  }
  return token;
}

export function validateSttExpiresAt(value, now = Date.now()) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new TypeError('STT expiresAt must be a positive epoch timestamp');
  }
  const expiresAtMs = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  if (expiresAtMs <= now + TOKEN_MIN_TTL_MS) {
    throw new TypeError('STT token is expired or too close to expiry');
  }
  return expiresAtMs;
}

export function validateSttTokenResponse(value, { expectedBaseUrl = '', model = '', now = Date.now() } = {}) {
  if (!value || typeof value !== 'object') throw new TypeError('STT token response is invalid');
  const token = validateSttToken(value.token);
  const url = validateVoiceStreamUrl(value.url, { expectedBaseUrl, model });
  const expiresAt = validateSttExpiresAt(value.expiresAt, now);
  return { token, url, expiresAt };
}

function transcriptionUrl(baseUrl) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return '';
  return /\/audio\/transcriptions$/i.test(base) ? base : `${base}/audio/transcriptions`;
}

function pcmFormat(sampleRate) {
  return {
    type: 'audio/pcm',
    sampleRate,
    channels: PCM_CHANNELS,
    bytesPerSample: PCM_BYTES_PER_SAMPLE,
    frameSize: sampleRate / 50,
  };
}

function wavBuffer(pcm, format) {
  const header = Buffer.alloc(44);
  const byteRate = format.sampleRate * format.channels * format.bytesPerSample;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(format.channels, 22);
  header.writeUInt32LE(format.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(format.channels * format.bytesPerSample, 32);
  header.writeUInt16LE(format.bytesPerSample * 8, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function timeoutController(timeoutMs, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abort();
  } else {
    signal?.addEventListener('abort', abort, { once: true });
  }
  const timer = setTimeout(() => {
    const error = new Error('STT timeout');
    error.name = 'TimeoutError';
    controller.abort(error);
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    },
  };
}

export class OpenAICompatibleStt {
  constructor({
    baseUrl = process.env.VOICE_STT_BASE_URL,
    apiKey = process.env.VOICE_STT_API_KEY,
    model = process.env.VOICE_STT_MODEL || 'whisper-1',
    timeoutMs = Number(process.env.VOICE_STT_TIMEOUT_MS) || 15_000,
    sampleRate = Number(process.env.VOICE_STT_SAMPLE_RATE) || 48_000,
  } = {}) {
    this.provider = 'openai-compatible';
    this.url = transcriptionUrl(validateVoiceGatewayUrl(baseUrl));
    this.apiKey = cleanConfigValue(apiKey);
    this.model = cleanConfigValue(model);
    this.timeoutMs = Math.max(1_000, timeoutMs);
    this.format = pcmFormat(sampleRate);
  }

  configured() {
    return Boolean(this.url && !isPlaceholder(this.apiKey) && !isPlaceholder(this.model));
  }

  audioFormat() {
    return this.format;
  }

  supportsStreamingInput() {
    return false;
  }

  async healthCheck({ signal } = {}) {
    if (signal?.aborted) return { ok: false, detail: 'STT health check aborted' };
    return {
      ok: this.configured(),
      detail: this.configured() ? '配置完整；需实际音频验证转写路由' : '配置不完整',
    };
  }

  async transcribe(pcm, { language = 'auto', signal } = {}) {
    if (!this.configured()) throw new Error('VOICE_STT_BASE_URL/API_KEY/MODEL 未完整配置');
    const timeout = timeoutController(this.timeoutMs, signal);

    try {
      const form = new FormData();
      form.append('file', new Blob([wavBuffer(pcm, this.format)], { type: 'audio/wav' }), 'voice-command.wav');
      form.append('model', this.model);
      const effectiveLanguage = language === 'mandarin' ? 'zh'
        : language === 'cantonese' ? 'yue'
          : language;
      if (effectiveLanguage && !['auto', 'mixed'].includes(effectiveLanguage)) form.append('language', effectiveLanguage);

      const response = await fetch(this.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
        signal: timeout.signal,
      });
      if (!response.ok) {
        throw Object.assign(new Error(`STT HTTP ${response.status}`), { status: response.status });
      }
      const result = await response.json();
      return {
        text: String(result.text || '').trim(),
        language: result.language || (effectiveLanguage === 'auto' ? null : effectiveLanguage),
      };
    } catch (error) {
      if (!signal?.aborted && timeout.signal.aborted && timeout.signal.reason?.name === 'TimeoutError') {
        throw timeout.signal.reason;
      }
      throw error;
    } finally {
      timeout.cleanup();
    }
  }
}

export class VercelGatewayStreamingStt {
  constructor({
    apiKey = process.env.VOICE_STT_GATEWAY_API_KEY
      || process.env.AI_GATEWAY_API_KEY
      || (process.env.VOICE_STT_GATEWAY_BASE_URL ? process.env.VOICE_STT_API_KEY : ''),
    model = process.env.VOICE_STT_MODEL || 'xai/grok-stt',
    baseUrl = process.env.VOICE_STT_GATEWAY_BASE_URL,
    timeoutMs = Number(process.env.VOICE_STT_TIMEOUT_MS) || 15_000,
    sampleRate = Number(process.env.VOICE_STT_SAMPLE_RATE) || 24_000,
  } = {}) {
    this.provider = 'vercel-ai-gateway';
    this.apiKey = cleanConfigValue(apiKey);
    const configuredModel = cleanConfigValue(model);
    this.model = configuredModel.includes('/') ? configuredModel : `xai/${configuredModel}`;
    this.baseUrl = validateVoiceGatewayUrl(baseUrl);
    this.timeoutMs = Math.max(1_000, timeoutMs);
    this.format = pcmFormat(sampleRate);
  }

  configured() {
    return Boolean(!isPlaceholder(this.apiKey) && this.model && !isPlaceholder(this.model));
  }

  audioFormat() {
    return this.format;
  }

  supportsStreamingInput() {
    return true;
  }

  gateway(apiKey, signal, baseUrl = this.baseUrl) {
    return createGateway({
      apiKey,
      ...(baseUrl ? { baseURL: baseUrl } : {}),
      ...(signal ? {
        fetch: (input, init = {}) => fetch(input, { ...init, signal }),
      } : {}),
    });
  }

  streamingGateway(token, streamUrl) {
    const parsed = new URL(streamUrl);
    const basePath = parsed.pathname.replace(/\/transcription-model$/i, '');
    const baseUrl = `https://${parsed.host}${basePath}`.replace(/\/+$/, '');
    return createGateway({ apiKey: token, baseURL: baseUrl });
  }

  async mintToken(signal) {
    if (!this.configured()) throw new Error('VOICE_STT_GATEWAY_API_KEY/MODEL 未配置');
    const response = await this.gateway(this.apiKey, signal).experimental_transcription.getToken({
      model: this.model,
    });
    return validateSttTokenResponse(response, {
      expectedBaseUrl: this.baseUrl,
      model: this.model,
    });
  }

  async healthCheck({ signal } = {}) {
    const timeout = timeoutController(this.timeoutMs, signal);
    try {
      const token = await this.mintToken(timeout.signal);
      return {
        ok: true,
        detail: `短期转写 Token 获取成功，有效至 ${new Date(token.expiresAt).toISOString()}`,
      };
    } catch (error) {
      if (!signal?.aborted && timeout.signal.aborted && timeout.signal.reason?.name === 'TimeoutError') {
        throw timeout.signal.reason;
      }
      throw error;
    } finally {
      timeout.cleanup();
    }
  }

  async transcribeStream(audio, {
    language = 'auto',
    keyterms = [],
    signal,
    onTranscript,
  } = {}) {
    const timeout = timeoutController(this.timeoutMs, signal);
    try {
      const { token, url } = await this.mintToken(timeout.signal);
      // The relay mints a Vercel client secret; the short-lived token then
      // connects to the official Gateway transcription WebSocket.
      const clientGateway = this.streamingGateway(token, url);
      const effectiveLanguage = language && language !== 'auto'
        && !['mixed', 'mandarin', 'cantonese'].includes(language)
        ? language
        : null;
      const result = streamTranscribe({
        model: clientGateway.transcription(this.model),
        audio,
        inputAudioFormat: {
          type: this.format.type,
          rate: this.format.sampleRate,
        },
        providerOptions: {
          xai: {
            ...(effectiveLanguage ? { language: effectiveLanguage } : {}),
            ...(keyterms.length > 0 ? { keyterm: keyterms.slice(0, 50) } : {}),
            streaming: {
              interimResults: true,
              endpointing: 500,
            },
          },
        },
        abortSignal: timeout.signal,
      });

      try {
        let streamedText = '';
        for await (const part of result.fullStream) {
          if (part.type === 'transcript-delta') {
            streamedText += part.delta;
            onTranscript?.(streamedText, part);
          }
          if (part.type === 'transcript-partial' && part.text) {
            streamedText = part.text;
            onTranscript?.(streamedText, part);
          }
          if (part.type === 'transcript-final' && part.text) {
            streamedText = part.text;
            onTranscript?.(streamedText, part);
          }
          if (part.type === 'error') {
            throw part.error instanceof Error
              ? part.error
              : new Error('Gateway transcription stream failed');
          }
        }

        const finalText = String(await result.text || streamedText).trim();
        return {
          text: finalText,
          language: await result.language || null,
        };
      } catch (error) {
        if (!signal?.aborted && timeout.signal.aborted && timeout.signal.reason?.name === 'TimeoutError') {
          throw timeout.signal.reason;
        }
        if (error?.name === 'AI_NoTranscriptGeneratedError') {
          return { text: '', language: null };
        }
        throw error;
      }
    } catch (error) {
      if (!signal?.aborted && timeout.signal.aborted && timeout.signal.reason?.name === 'TimeoutError') {
        throw timeout.signal.reason;
      }
      throw error;
    } finally {
      timeout.cleanup();
    }
  }

  async transcribe(pcm, options = {}) {
    const audio = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(pcm));
        controller.close();
      },
    });
    return this.transcribeStream(audio, options);
  }
}

export function createVoiceStt(options = {}) {
  const configuredProvider = options.provider ?? process.env.VOICE_STT_PROVIDER ?? 'openai-compatible';
  const provider = cleanConfigValue(configuredProvider).toLowerCase();
  if (!provider || isPlaceholder(provider)) {
    throw new TypeError('Unsupported voice STT provider');
  }
  if (provider === 'vercel-ai-gateway') return new VercelGatewayStreamingStt(options);
  if (provider === 'openai-compatible') return new OpenAICompatibleStt(options);
  throw new TypeError(`Unsupported voice STT provider: ${String(provider).slice(0, 40)}`);
}
