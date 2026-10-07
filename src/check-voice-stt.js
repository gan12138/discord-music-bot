import 'dotenv/config';
import { createVoiceStt } from './utils/voiceStt.js';

const stt = createVoiceStt();
const format = stt.audioFormat();

console.log(`Provider: ${stt.provider}`);
console.log(`Model: ${stt.model}`);
console.log(`Input: ${format.type} ${format.sampleRate}Hz mono`);

if (!stt.configured()) {
  console.error('STT 配置不完整。Gateway 模式需要 VOICE_STT_GATEWAY_API_KEY。');
  process.exitCode = 1;
} else {
  const result = await stt.healthCheck();
  console.log(result.ok ? `OK: ${result.detail}` : `FAILED: ${result.detail}`);
  if (!result.ok) process.exitCode = 1;
}
