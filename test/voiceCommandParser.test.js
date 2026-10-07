import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeVoiceText,
  parseVoiceCommand,
  voiceCommandKeyterms,
  voiceLanguageLabel,
  voiceUnderstandingLabel,
} from '../src/utils/voiceCommandParser.js';

const wakeWords = ['音乐助手', '小音箱'];

test('normalizes punctuation and whitespace', () => {
  assert.equal(normalizeVoiceText(' 音乐助手，  暂停！ '), '音乐助手 暂停');
});

test('parses commands with multiple leading wake words', () => {
  assert.deepEqual(
    parseVoiceCommand({ text: '音乐助手，暂停播放', wakeWords }).command,
    'pause',
  );
  const play = parseVoiceCommand({ text: '小音箱 play never gonna give you up', wakeWords });
  assert.equal(play.command, 'play');
  assert.equal(play.query, 'never gonna give you up');
});

test('parses the reported Luodayou Capital voice request exactly', () => {
  const parsed = parseVoiceCommand({
    text: '语音助手播放罗大佑的首都',
    wakeWords: ['音乐助手', '语音助手'],
    understandingMode: 'strict',
  });
  assert.equal(parsed.matched, true);
  assert.equal(parsed.wakeWord, '语音助手');
  assert.equal(parsed.command, 'play');
  assert.equal(parsed.query, '罗大佑的首都');
});

test('rejects wake words embedded in ordinary speech', () => {
  const result = parseVoiceCommand({ text: '我觉得音乐助手应该暂停', wakeWords });
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'no-leading-wake-word');
});

test('supports a wake-only segment followed by a command window', () => {
  const now = 1_000;
  const wake = parseVoiceCommand({ text: '音乐助手', wakeWords, now });
  assert.equal(wake.reason, 'wake-only');
  const command = parseVoiceCommand({
    text: '下一首',
    wakeWords,
    now: now + 1_000,
    wakeActiveUntil: wake.nextWakeActiveUntil,
  });
  assert.equal(command.command, 'skip');
  assert.equal(command.usedWakeWindow, true);
});

test('parses previous-track commands without confusing them with skip', () => {
  assert.equal(parseVoiceCommand({ text: '音乐助手，上一首', wakeWords }).command, 'previous');
  assert.equal(parseVoiceCommand({ text: '音乐助手，返回上一首', wakeWords }).command, 'previous');
  assert.equal(parseVoiceCommand({ text: '音樂助手，播返上一首', wakeWords: ['音樂助手'], language: 'mixed' }).command, 'previous');
  assert.equal(parseVoiceCommand({ text: '音乐助手，下一首', wakeWords }).command, 'skip');
});

test('requires a complete command and rejects expired windows', () => {
  assert.equal(parseVoiceCommand({ text: '音乐助手我想听歌', wakeWords }).matched, false);
  assert.equal(parseVoiceCommand({ text: '暂停', wakeWords, now: 10, wakeActiveUntil: 9 }).matched, false);
});

test('does not treat similar ordinary prefixes as a wake command', () => {
  assert.equal(parseVoiceCommand({ text: '请大家使用音乐助手暂停', wakeWords }).matched, false);
  assert.equal(parseVoiceCommand({ text: '你觉得小音箱下一首怎么样', wakeWords }).matched, false);
});

test('supports Cantonese play and controls in mixed mode', () => {
  const play = parseVoiceCommand({
    text: '音樂助手，幫我播羅大佑嘅童年',
    wakeWords: ['音樂助手'],
    language: 'mixed',
  });
  assert.equal(play.command, 'play');
  assert.equal(play.query, '羅大佑嘅童年');
  assert.equal(parseVoiceCommand({ text: '音樂助手，停一停', wakeWords: ['音樂助手'], language: 'mixed' }).command, 'pause');
  assert.equal(parseVoiceCommand({ text: '音樂助手，播返', wakeWords: ['音樂助手'], language: 'mixed' }).command, 'resume');
  assert.equal(parseVoiceCommand({ text: '音樂助手，飛歌', wakeWords: ['音樂助手'], language: 'mixed' }).command, 'skip');
});

test('matches simplified and traditional music wake-word variants', () => {
  const parsed = parseVoiceCommand({
    text: '音樂助手，幫我播童年',
    wakeWords: ['音乐助手'],
    language: 'mixed',
  });
  assert.equal(parsed.wakeWord, '音乐助手');
  assert.equal(parsed.query, '童年');
});

test('respects configured language mode', () => {
  assert.equal(parseVoiceCommand({
    text: '音乐助手，停一下',
    wakeWords: ['音乐助手'],
    language: 'cantonese',
  }).matched, false);
  assert.equal(parseVoiceCommand({
    text: '音樂助手，飛歌',
    wakeWords: ['音樂助手'],
    language: 'mandarin',
  }).matched, false);
});

test('prefers the longest overlapping wake word', () => {
  const parsed = parseVoiceCommand({
    text: '音乐助手播放童年',
    wakeWords: ['音乐', '音乐助手'],
  });
  assert.equal(parsed.wakeWord, '音乐助手');
  assert.equal(parsed.query, '童年');
});

test('exposes bilingual labels and STT keyterms', () => {
  assert.equal(voiceLanguageLabel('auto'), '普通话 + 粤语');
  assert.equal(voiceLanguageLabel('cantonese'), '粤语');
  const keyterms = voiceCommandKeyterms('mixed');
  assert.ok(keyterms.includes('暂停'));
  assert.ok(keyterms.includes('飛歌'));
  assert.ok(keyterms.includes('上一首'));
  assert.equal(voiceUnderstandingLabel('balanced'), 'AI 平衡模式');
});

test('balanced mode accepts one-character wake-word errors', () => {
  const replacement = parseVoiceCommand({
    text: '音乐助理播放童年',
    wakeWords: ['音乐助手'],
    understandingMode: 'balanced',
  });
  assert.equal(replacement.matched, false);
  assert.equal(replacement.reason, 'fuzzy-wake-needs-ai');
  assert.equal(replacement.fuzzyWake, true);
  assert.equal(replacement.candidateQuery, '童年');

  const deletion = parseVoiceCommand({
    text: '音乐手我想听罗大佑童年',
    wakeWords: ['音乐助手'],
    understandingMode: 'balanced',
  });
  assert.equal(deletion.reason, 'fuzzy-wake-needs-ai');
  assert.equal(deletion.fuzzyWake, true);
  assert.equal(deletion.commandText, '我想听罗大佑童年');
});

test('strict mode rejects fuzzy wake words', () => {
  const parsed = parseVoiceCommand({
    text: '音乐助理播放童年',
    wakeWords: ['音乐助手'],
    understandingMode: 'strict',
  });
  assert.equal(parsed.reason, 'no-leading-wake-word');
});

test('balanced mode still rejects weak or embedded wake candidates', () => {
  assert.equal(parseVoiceCommand({
    text: '音乐播放童年',
    wakeWords: ['音乐助手'],
    understandingMode: 'balanced',
  }).reason, 'no-leading-wake-word');
  assert.equal(parseVoiceCommand({
    text: '我觉得音乐助理不错',
    wakeWords: ['音乐助手'],
    understandingMode: 'balanced',
  }).reason, 'no-leading-wake-word');
  for (const text of [
    '音乐歌手播放童年',
    '音乐选手播放童年',
    '音乐新手播放童年',
    '音乐助教今天来了',
    '音乐助力计划暂停',
    '音乐助眠下一首',
  ]) {
    assert.equal(parseVoiceCommand({
      text,
      wakeWords: ['音乐助手'],
      understandingMode: 'balanced',
    }).reason, 'no-leading-wake-word');
  }
});

test('fuzzy deletion does not consume the first command character', () => {
  const play = parseVoiceCommand({
    text: '音乐助播放童年',
    wakeWords: ['音乐助手'],
    understandingMode: 'balanced',
  });
  assert.equal(play.commandText, '播放童年');
  assert.equal(play.candidateQuery, '童年');
  const pause = parseVoiceCommand({
    text: '音乐助暂停',
    wakeWords: ['音乐助手'],
    understandingMode: 'balanced',
  });
  assert.equal(pause.commandText, '暂停');
  assert.equal(pause.candidateCommand, 'pause');
});
