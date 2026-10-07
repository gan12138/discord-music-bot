// Keep decisions independent of user-facing translations and aggregate client order.
function classifyMessage(message) {
  if (/no available node|no lavalink node|lavalink.*(?:unavailable|disconnected)|语音连接不存在|连接语音频道超时|voice.*(?:not ready|closed)/i.test(message)) return 'backend-unavailable';
  if (/recovery.*deadline|恢复时间预算/i.test(message)) return 'recovery-deadline';
  if (/no such option|unknown option|ENOENT|command not found|not installed/i.test(message)) return 'environment';
  if (/private video|video is private|video.*(?:removed|deleted)|removed by|not available in your country|not made.*available.*country|视频是私有/i.test(message)) return 'content-restricted';
  if (/signal\s+SIG[A-Z0-9]+/i.test(message)) return 'process-crash';
  if (/network is unreachable|no route to host|NoRouteToHostException|\b(?:ENETUNREACH|EHOSTUNREACH)\b/i.test(message)) return 'network-unreachable';
  if (/timed? out|timeout|超时/i.test(message)) return 'network-timeout';
  if (/connection reset|ECONNRESET|premature|bytes read.*more expected|中途断开|断流|无数据/i.test(message)) return 'network-interrupted';
  if (/sign in|requires login|confirm.*not a bot|age[- ]restricted|验证登录|机器人验证|412|precondition failed/i.test(message)) return 'auth-required';
  if (/403|forbidden/i.test(message)) return 'http-forbidden';
  if (/no supported audio|requested format.*not available|only images|没有可用音频格式/i.test(message)) return 'no-supported-stream';
  if (/not available|unavailable|视频当前不可用/i.test(message)) return 'content-unavailable';
  return 'unknown';
}

export function classifyPlaybackError(error, source = '') {
  const rawMessage = String(error?.message || error || '');
  const extractorError = rawMessage.indexOf('ERROR:');
  const message = source === 'yt-dlp' && extractorError >= 0 ? rawMessage.slice(extractorError) : rawMessage;
  const clients = [...message.matchAll(/Client \[([^\]]+)\] failed:\s*([^\n]*)/gi)]
    .map(([, client, detail]) => ({ client, category: classifyMessage(detail) }));
  // TV is the OAuth playback client. A secondary client's 403/login error must
  // not mask a transient TV failure, nor justify retrying a permanent TV failure.
  const primary = clients.find(({ client }) => /^(?:TV|TVHTML5)$/i.test(client)) || clients[0];
  const category = primary?.category || classifyMessage(`${error?.code || ''} ${message}`);
  return {
    category,
    clients,
    primaryClient: primary?.client || null,
    transient: ['network-timeout', 'network-interrupted', 'network-unreachable'].includes(category) || source === 'stream-stall',
    localRetries: ['content-restricted', 'auth-required', 'environment', 'backend-unavailable', 'recovery-deadline'].includes(category)
      ? 0 : ['content-unavailable', 'http-forbidden', 'no-supported-stream', 'unknown'].includes(category) ? 1 : 2,
  };
}

export function playbackErrorText(error, source = '') {
  const category = error?.category || classifyPlaybackError(error, source).category;
  return {
    'network-timeout': '音源读取超时',
    'network-interrupted': '音源连接中途断开',
    'network-unreachable': '音源网络不可达，暂时无法连接音频服务器',
    'auth-required': '平台要求登录或验证当前访问方式',
    'http-forbidden': '平台拒绝音频请求（403），需要重新解析音源或检查访问条件',
    'content-restricted': '视频已被删除、设为私有或明确限制当前地区访问',
    'content-unavailable': '平台当前无法提供此视频的音频',
    'no-supported-stream': '当前访问方式没有可用音频格式',
    'backend-unavailable': '播放服务或语音连接暂时不可用',
    environment: '本地播放程序或参数不兼容，请检查 yt-dlp/ffmpeg 环境',
    'recovery-deadline': '已达到本轮播放恢复时间上限',
    'process-crash': '本地转码进程异常退出',
    unknown: '音源加载失败',
  }[category] || '音源加载失败';
}

// The underlying operation may not expose cancellation (Lavalink REST). Its
// caller must also check playbackId/generation after awaiting this wrapper.
export function withPlaybackSignal(operation, signal) {
  if (!signal) return Promise.resolve().then(operation);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = callback => value => {
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject)(signal.reason || new Error('Playback cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(finish(resolve), finish(reject));
  });
}
