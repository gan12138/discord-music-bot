const LANGUAGE_LABELS = Object.freeze({
  mixed: '普通话 + 粤语',
  mandarin: '普通话',
  cantonese: '粤语',
});
const UNDERSTANDING_LABELS = Object.freeze({
  strict: '严格模式',
  balanced: 'AI 平衡模式',
});

const MANDARIN_KEYTERMS = Object.freeze([
  '播放', '放一下', '点播', '暂停', '停一下', '继续', '恢复播放', '上一首', '上一曲', '下一首', '跳过', '切歌',
]);
const CANTONESE_KEYTERMS = Object.freeze([
  '播放', '播', '帮我播', '幫我播', '暂停', '暫停', '停一停', '继续', '繼續', '播返', '上一首', '上一曲', '飞歌', '飛歌', '下一首',
]);
const FUZZY_SUBSTITUTIONS = new Set([
  '助住', '助注', '助驻', '助主',
  '手首', '手守', '手理',
]);

export function normalizeVoiceLanguage(value) {
  const language = String(value || '').trim().toLowerCase();
  if (language === 'auto') return 'mixed';
  if (language === 'zh' || language === 'zh-cn' || language === 'cmn') return 'mandarin';
  if (language === 'yue' || language === 'zh-hk') return 'cantonese';
  return Object.hasOwn(LANGUAGE_LABELS, language) ? language : 'mixed';
}

export function voiceLanguageLabel(value) {
  return LANGUAGE_LABELS[normalizeVoiceLanguage(value)];
}

export function normalizeVoiceUnderstanding(value) {
  return value === 'strict' ? 'strict' : 'balanced';
}

export function voiceUnderstandingLabel(value) {
  return UNDERSTANDING_LABELS[normalizeVoiceUnderstanding(value)];
}

export function voiceCommandKeyterms(value) {
  const language = normalizeVoiceLanguage(value);
  if (language === 'mandarin') return [...MANDARIN_KEYTERMS];
  if (language === 'cantonese') return [...CANTONESE_KEYTERMS];
  return [...new Set([...MANDARIN_KEYTERMS, ...CANTONESE_KEYTERMS])];
}

export function normalizeVoiceText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[，。！？、,.!?;；:："“”'‘’()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function compact(value) {
  return normalizeVoiceText(value).replace(/\s+/g, '');
}

function compactWithOffsets(value) {
  const normalized = normalizeVoiceText(value);
  let text = '';
  const offsets = [];
  for (let index = 0; index < normalized.length; index++) {
    if (/\s/u.test(normalized[index])) continue;
    text += normalized[index];
    offsets.push(index);
  }
  return { normalized, text, offsets };
}

function wakeWordForms(value) {
  const word = compact(value);
  if (!word) return [];
  const simplified = word.replaceAll('樂', '乐');
  const traditional = word.replaceAll('乐', '樂');
  return [...new Set([word, simplified, traditional])];
}

function editDistanceAtMostOne(left, right) {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 1) return null;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return null;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  if (i < left.length || j < right.length) edits += 1;
  return edits <= 1 ? edits : null;
}

function allowedFuzzyEdit(heard, expected) {
  if (Math.abs(heard.length - expected.length) === 1) return true;
  if (heard.length !== expected.length) return false;
  const mismatches = [];
  for (let index = 0; index < expected.length; index++) {
    if (heard[index] !== expected[index]) mismatches.push([expected[index], heard[index]]);
  }
  if (mismatches.length !== 1) return false;
  const [expectedCharacter, heardCharacter] = mismatches[0];
  return FUZZY_SUBSTITUTIONS.has(`${expectedCharacter}${heardCharacter}`)
    || FUZZY_SUBSTITUTIONS.has(`${heardCharacter}${expectedCharacter}`);
}

function commandFromText(value, languageMode = 'mixed') {
  const language = normalizeVoiceLanguage(languageMode);
  const allowMandarin = language !== 'cantonese';
  const allowCantonese = language !== 'mandarin';
  const normalized = normalizeVoiceText(value);
  const text = compact(normalized);
  const pausePatterns = [
    ...(allowMandarin ? [/^(?:请)?(?:暂停|停一下|暂停播放)(?:音乐|播放)?$/i] : []),
    ...(allowCantonese ? [/^(?:唔该|唔該|请|請)?(?:暫停|暂停|停一停|停低|暫停播放)(?:音樂|音乐|播放)?$/i] : []),
    /^(?:pause)$/i,
  ];
  const resumePatterns = [
    ...(allowMandarin ? [/^(?:请)?(?:继续|继续播放|恢复|恢复播放)(?:音乐|播放)?$/i] : []),
    ...(allowCantonese ? [/^(?:唔该|唔該|请|請)?(?:繼續|继续|繼續播放|继续播放|繼續播|继续播|播返|播翻)(?:音樂|音乐)?$/i] : []),
    /^(?:resume|continue)$/i,
  ];
  const previousPatterns = [
    ...(allowMandarin ? [/^(?:请)?(?:上一首|上一曲|返回上一首|回到上一首|播放上一首)(?:歌|歌曲|音乐)?$/i] : []),
    ...(allowCantonese ? [/^(?:唔该|唔該|请|請)?(?:上一首|上一曲|播返上一首|播翻上一首|返上一首|對上一首|对上一首)(?:歌|歌曲|音樂|音乐)?$/i] : []),
    /^(?:previous|prev)$/i,
  ];
  const skipPatterns = [
    ...(allowMandarin ? [/^(?:请)?(?:跳过|下一首|切歌)(?:这首|歌曲|音乐)?$/i] : []),
    ...(allowCantonese ? [/^(?:唔该|唔該|请|請)?(?:跳過|跳过|下一首|切歌|飛歌|飞歌)(?:呢首|這首|这首|歌曲|音樂|音乐)?$/i] : []),
    /^(?:skip|next)$/i,
  ];
  if (pausePatterns.some(pattern => pattern.test(text))) return { command: 'pause', query: null };
  if (resumePatterns.some(pattern => pattern.test(text))) return { command: 'resume', query: null };
  if (previousPatterns.some(pattern => pattern.test(text))) return { command: 'previous', query: null };
  if (skipPatterns.some(pattern => pattern.test(text))) return { command: 'skip', query: null };

  const playPrefixes = [
    ...(allowMandarin ? ['播放', '放一下', '放一首', '点播'] : []),
    ...(allowCantonese ? ['幫我播', '帮我播', '播一首', '播放', '播'] : []),
  ].sort((a, b) => b.length - a.length).join('|');
  const playMatch = normalized.match(new RegExp(`^(?:(?:请|請|唔该|唔該)\\s*)?(?:${playPrefixes}|play)\\s+(.+)$`, 'i'))
    || text.match(new RegExp(`^(?:(?:请|請|唔该|唔該))?(?:${playPrefixes})(.+)$`, 'i'));
  const query = playMatch?.[1]?.trim();
  if (query && query.length >= 1) return { command: 'play', query };
  return null;
}

function findLeadingWakeWord(text, wakeWords) {
  const { normalized, text: compactText, offsets } = compactWithOffsets(text);
  const allowedPrefixes = ['', 'hey', 'hi', 'hello', '嘿', '嗨', '你好', '请问'];

  const candidates = [...(wakeWords || [])]
    .flatMap(rawWakeWord => wakeWordForms(rawWakeWord).map(wakeWord => ({ rawWakeWord, wakeWord })))
    .sort((a, b) => b.wakeWord.length - a.wakeWord.length);

  for (const { rawWakeWord, wakeWord } of candidates) {
    const index = compactText.indexOf(wakeWord);
    if (index < 0 || index > 8) continue;
    const prefix = compactText.slice(0, index);
    if (!allowedPrefixes.includes(prefix)) continue;
    const endOffset = offsets[index + wakeWord.length - 1];
    return {
      wakeWord: rawWakeWord,
      remainder: Number.isInteger(endOffset)
        ? normalized.slice(endOffset + 1).trim()
        : compactText.slice(index + wakeWord.length),
    };
  }
  return null;
}

function findFuzzyLeadingWakeWord(text, wakeWords) {
  const { normalized, text: compactText, offsets } = compactWithOffsets(text);
  const allowedPrefixes = ['', 'hey', 'hi', 'hello', '嘿', '嗨', '你好', '请问'];
  const candidates = [...(wakeWords || [])]
    .flatMap(rawWakeWord => wakeWordForms(rawWakeWord).map(wakeWord => ({ rawWakeWord, wakeWord })))
    .filter(candidate => candidate.wakeWord.length >= 4)
    .sort((a, b) => b.wakeWord.length - a.wakeWord.length);
  let best = null;

  for (const prefix of allowedPrefixes) {
    if (!compactText.startsWith(prefix)) continue;
    const body = compactText.slice(prefix.length);
    for (const { rawWakeWord, wakeWord } of candidates) {
      for (const length of [wakeWord.length, wakeWord.length - 1, wakeWord.length + 1]) {
        if (length < 1 || body.length < length) continue;
        const heardWakeWord = body.slice(0, length);
        const distance = editDistanceAtMostOne(heardWakeWord, wakeWord);
        if (distance !== 1 || !allowedFuzzyEdit(heardWakeWord, wakeWord)) continue;
        const consumedLength = prefix.length + length;
        const endOffset = offsets[consumedLength - 1];
        const remainder = Number.isInteger(endOffset)
          ? normalized.slice(endOffset + 1).trim()
          : body.slice(length);
        const directCommand = commandFromText(remainder, 'mixed');
        const naturalCommand = /^(?:我想|想听|想聽|给我|給我|来首|來首|帮我|幫我|先别|先別|接着|接著|继续|繼續|恢复|恢復|返回|回到|上一首|上一曲|呢首|这首|這首|换歌|換歌|播返|返上一首)/u.test(compact(remainder));
        if (remainder && !directCommand && !naturalCommand) continue;
        const score = (directCommand ? 4 : naturalCommand ? 3 : remainder ? 1 : 0)
          + (length === wakeWord.length ? 0.25 : 0);
        const match = {
          wakeWord: rawWakeWord,
          heardWakeWord,
          wakeDistance: distance,
          fuzzyWake: true,
          remainder,
          score,
        };
        if (!best || score > best.score || (score === best.score && heardWakeWord.length > best.heardWakeWord.length)) {
          best = match;
        }
      }
    }
  }
  return best;
}

export function parseVoiceCommand({
  text,
  wakeWords,
  wakeActiveUntil = 0,
  now = Date.now(),
  wakeWindowMs = 8_000,
  language = 'mixed',
  understandingMode = 'strict',
} = {}) {
  const normalizedText = normalizeVoiceText(text);
  if (!normalizedText) return { matched: false, reason: 'empty' };

  const leadingWake = findLeadingWakeWord(normalizedText, wakeWords)
    || (normalizeVoiceUnderstanding(understandingMode) === 'balanced'
      ? findFuzzyLeadingWakeWord(normalizedText, wakeWords)
      : null);
  if (leadingWake) {
    if (!leadingWake.remainder) {
      return {
        matched: false,
        reason: 'wake-only',
        wakeWord: leadingWake.wakeWord,
        fuzzyWake: Boolean(leadingWake.fuzzyWake),
        heardWakeWord: leadingWake.heardWakeWord || null,
        wakeDistance: leadingWake.wakeDistance || 0,
        commandText: '',
        nextWakeActiveUntil: now + wakeWindowMs,
      };
    }
    const parsed = commandFromText(leadingWake.remainder, language);
    if (leadingWake.fuzzyWake) {
      return {
        matched: false,
        reason: 'fuzzy-wake-needs-ai',
        candidateCommand: parsed?.command || null,
        candidateQuery: parsed?.query || null,
        wakeWord: leadingWake.wakeWord,
        fuzzyWake: true,
        heardWakeWord: leadingWake.heardWakeWord,
        wakeDistance: leadingWake.wakeDistance,
        commandText: leadingWake.remainder,
        nextWakeActiveUntil: now + wakeWindowMs,
      };
    }
    return parsed
      ? {
          matched: true,
          ...parsed,
          wakeWord: leadingWake.wakeWord,
          fuzzyWake: Boolean(leadingWake.fuzzyWake),
          heardWakeWord: leadingWake.heardWakeWord || null,
          wakeDistance: leadingWake.wakeDistance || 0,
          commandText: leadingWake.remainder,
          usedWakeWindow: false,
        }
      : {
          matched: false,
          reason: 'unknown-command',
          wakeWord: leadingWake.wakeWord,
          fuzzyWake: Boolean(leadingWake.fuzzyWake),
          heardWakeWord: leadingWake.heardWakeWord || null,
          wakeDistance: leadingWake.wakeDistance || 0,
          commandText: leadingWake.remainder,
          nextWakeActiveUntil: now + wakeWindowMs,
        };
  }

  if (wakeActiveUntil > now) {
    const parsed = commandFromText(normalizedText, language);
    return parsed
      ? { matched: true, ...parsed, wakeWord: null, commandText: normalizedText, usedWakeWindow: true }
      : { matched: false, reason: 'unknown-window-command', commandText: normalizedText, usedWakeWindow: true };
  }

  return { matched: false, reason: 'no-leading-wake-word' };
}
