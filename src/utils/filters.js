export const AUDIO_FILTERS = {
  none: {
    label: '关闭',
    ffmpeg: null,
  },
  bassboost: {
    label: '低音增强',
    ffmpeg: 'bass=g=8',
  },
  nightcore: {
    label: 'Nightcore',
    ffmpeg: 'asetrate=48000*1.25,aresample=48000,atempo=1.0',
  },
  slowed: {
    label: '慢速',
    ffmpeg: 'asetrate=48000*0.85,aresample=48000,atempo=1.0',
  },
  spedup: {
    label: '加速',
    ffmpeg: 'asetrate=48000*1.15,aresample=48000,atempo=1.0',
  },
  reverb: {
    label: '混响',
    ffmpeg: 'aecho=0.8:0.9:40|60:0.35|0.25',
  },
  '8d': {
    label: '8D',
    ffmpeg: 'apulsator=hz=0.08',
  },
  muffled: {
    label: '低通闷音',
    ffmpeg: 'lowpass=f=500',
  },
};

export function normalizeFilterMode(mode) {
  return Object.hasOwn(AUDIO_FILTERS, mode) ? mode : null;
}

export function filterLabel(mode) {
  return AUDIO_FILTERS[mode]?.label || AUDIO_FILTERS.none.label;
}

export function buildAudioFilter(volume, mode = 'none') {
  const filters = [];
  if (process.env.AUDIO_NORMALIZATION === 'true') {
    filters.push('loudnorm=I=-16:TP=-1.5:LRA=11');
  }
  filters.push(`volume=${Math.max(0, Number(volume) || 0) / 100}`);
  const normalized = normalizeFilterMode(mode) || 'none';
  const effect = AUDIO_FILTERS[normalized].ffmpeg;
  if (effect) filters.push(effect);
  return filters.join(',');
}
