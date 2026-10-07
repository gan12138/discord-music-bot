import { GuildSettings } from '../models/database.js';

const DISCORD_ID_RE = /^\d{16,22}$/;

function normalizedUserId(userId) {
  const value = String(userId || '').trim();
  return DISCORD_ID_RE.test(value) ? value : null;
}

export function voiceSttAccessMode(settings) {
  if (settings?.sttAccessMode === 'off') return 'off';
  if (settings?.sttAccessMode === 'everyone') return 'everyone';
  if (settings && Object.prototype.hasOwnProperty.call(settings, 'sttAccessMode')) return 'off';
  return settings?.cloudSttEnabled === false ? 'off' : 'everyone';
}

export function isVoiceSttAllowed(settings, userId) {
  const normalizedId = normalizedUserId(userId);
  if (!normalizedId) return false;
  const mode = voiceSttAccessMode(settings);
  if (mode === 'off') return false;
  if (settings?.sttOptOutUserIds?.includes(normalizedId)) return false;
  return true;
}

export function voiceConsentStatus(guildId, userId) {
  const settings = GuildSettings.get(guildId).voiceControl;
  const normalizedId = normalizedUserId(userId);
  const sttAccessMode = voiceSttAccessMode(settings);
  return {
    sttAccessMode,
    cloudSttEnabled: sttAccessMode !== 'off',
    consented: Boolean(normalizedId && settings.consentedUserIds.includes(normalizedId)),
    optedOut: Boolean(normalizedId && settings.sttOptOutUserIds.includes(normalizedId)),
    effectiveAllowed: isVoiceSttAllowed(settings, normalizedId),
    consentedUserCount: settings.consentedUserIds.length,
    optedOutUserCount: settings.sttOptOutUserIds.length,
  };
}

export function setVoiceSttAccessMode(guildId, mode) {
  if (!['off', 'everyone'].includes(mode)) {
    return { ok: false, reason: 'invalid-mode' };
  }
  const settings = GuildSettings.update(guildId, {
    voiceControl: {
      sttAccessMode: mode,
      ...(mode === 'off' ? { consentedUserIds: [] } : {}),
    },
  }).voiceControl;
  return { ok: true, settings };
}

export function setCloudSttEnabled(guildId, enabled) {
  return setVoiceSttAccessMode(guildId, enabled === true ? 'everyone' : 'off').settings;
}

export function grantVoiceConsent(guildId, userId) {
  const normalizedId = normalizedUserId(userId);
  if (!normalizedId) return { ok: false, reason: 'invalid-user' };
  const current = GuildSettings.get(guildId).voiceControl;
  const mode = voiceSttAccessMode(current);
  if (mode === 'off') return { ok: false, reason: 'server-disabled' };
  if (!current.sttOptOutUserIds.includes(normalizedId)) {
    return { ok: true, changed: false, settings: current, mode: 'everyone' };
  }
  const settings = GuildSettings.update(guildId, {
    voiceControl: {
      sttOptOutUserIds: current.sttOptOutUserIds.filter(id => id !== normalizedId),
    },
  }).voiceControl;
  return { ok: true, changed: true, settings, mode: 'everyone' };
}

export function revokeVoiceConsent(guildId, userId) {
  const normalizedId = normalizedUserId(userId);
  if (!normalizedId) return { ok: false, reason: 'invalid-user' };
  const current = GuildSettings.get(guildId).voiceControl;
  const mode = voiceSttAccessMode(current);
  const alreadyOptedOut = current.sttOptOutUserIds.includes(normalizedId);
  if (alreadyOptedOut) {
    return { ok: true, changed: false, settings: current };
  }
  const settings = GuildSettings.update(guildId, {
    voiceControl: {
      consentedUserIds: current.consentedUserIds.filter(id => id !== normalizedId),
      sttOptOutUserIds: alreadyOptedOut
        ? current.sttOptOutUserIds
        : [...current.sttOptOutUserIds, normalizedId],
    },
  }).voiceControl;
  if (!settings.sttOptOutUserIds.includes(normalizedId)) {
    return { ok: false, reason: 'opt-out-limit', settings, mode };
  }
  return { ok: true, changed: true, settings, mode };
}
