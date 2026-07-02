export function parseSeekTime(value) {
  const input = String(value || '').trim();
  if (!input) return null;

  if (/^\d+$/.test(input)) {
    return Number(input);
  }

  const parts = input.split(':');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every(part => /^\d+$/.test(part))) return null;

  const numbers = parts.map(Number);
  if (numbers.some(number => Number.isNaN(number))) return null;

  if (numbers.length === 2) {
    const [minutes, seconds] = numbers;
    if (seconds >= 60) return null;
    return minutes * 60 + seconds;
  }

  const [hours, minutes, seconds] = numbers;
  if (minutes >= 60 || seconds >= 60) return null;
  return hours * 3600 + minutes * 60 + seconds;
}

export function formatSeekTime(totalSeconds) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
  }
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

export function durationToSeconds(duration) {
  if (!duration || typeof duration !== 'string') return null;
  return parseSeekTime(duration);
}
