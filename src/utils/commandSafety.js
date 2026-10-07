import { PermissionFlagsBits } from 'discord.js';
import { GuildSettings } from '../models/database.js';

const CONTROL_CHAR_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;
const CONTROL_CHAR_RE_GLOBAL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const ANSI_ESCAPE_RE = /\u001b\[[0-?]*[ -/]*[@-~]/;
const ANSI_ESCAPE_RE_GLOBAL = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function hasUnsafeControlChars(value) {
  return CONTROL_CHAR_RE.test(String(value || '')) || ANSI_ESCAPE_RE.test(String(value || ''));
}

export function safeText(value, maxLength = 1900) {
  let text = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(ANSI_ESCAPE_RE_GLOBAL, '')
    .replace(CONTROL_CHAR_RE_GLOBAL, '');
  const characters = Array.from(text);
  if (characters.length <= maxLength) return text;
  const suffix = '...';
  return `${characters.slice(0, Math.max(0, maxLength - suffix.length)).join('')}${suffix}`;
}

export function safePayload(payload, maxLength = 1900) {
  if (typeof payload === 'string') {
    return { content: safeText(payload, maxLength), allowedMentions: { parse: [] } };
  }
  if (!payload || typeof payload !== 'object') return payload;
  const result = { ...payload };
  if (typeof result.content === 'string') result.content = safeText(result.content, maxLength);
  if (Array.isArray(result.embeds)) {
    result.embeds = result.embeds.map(embed => sanitizeEmbed(embed));
  }
  if (Array.isArray(result.components)) {
    result.components = result.components.map(component => {
      const json = typeof component?.toJSON === 'function' ? component.toJSON() : component;
      return json;
    });
  }
  result.allowedMentions = { ...(result.allowedMentions || {}), parse: [] };
  return result;
}

function sanitizeEmbed(embed) {
  const value = typeof embed?.toJSON === 'function' ? embed.toJSON() : { ...embed };
  if (typeof value.title === 'string') value.title = safeText(value.title, 256);
  if (typeof value.description === 'string') value.description = safeText(value.description, 4096);
  if (value.author?.name) value.author = { ...value.author, name: safeText(value.author.name, 256) };
  if (value.footer?.text) value.footer = { ...value.footer, text: safeText(value.footer.text, 2048) };
  if (Array.isArray(value.fields)) {
    value.fields = value.fields.map(field => ({
      ...field,
      name: safeText(field?.name || '', 256),
      value: safeText(field?.value || '', 1024),
    }));
  }
  return value;
}

function editablePayload(payload) {
  const result = safePayload(payload);
  if (result && typeof result === 'object' && 'flags' in result) {
    const flags = Number(result.flags);
    if (Number.isFinite(flags)) {
      const editableFlags = flags & ~64;
      if (editableFlags) result.flags = editableFlags;
      else delete result.flags;
    }
  }
  return result;
}

export function protectInteraction(interaction) {
  if (!interaction || interaction.__commandSafetyWrapped) return interaction;
  Object.defineProperty(interaction, '__commandSafetyWrapped', { value: true, configurable: true });
  for (const method of ['reply', 'editReply', 'followUp', 'update']) {
    if (typeof interaction[method] !== 'function') continue;
    const original = interaction[method].bind(interaction);
    interaction[method] = payload => original(method === 'editReply' ? editablePayload(payload) : safePayload(payload));
  }
  return interaction;
}

export function safeReply(interaction, payload) {
  return interaction.reply(safePayload(payload));
}

export function safeEditReply(interaction, payload) {
  return interaction.editReply(editablePayload(payload));
}

export function safeUpdate(interaction, payload) {
  return interaction.update(safePayload(payload));
}

export async function respondInteraction(interaction, payload) {
  if (interaction?.deferred) return safeEditReply(interaction, payload);
  if (interaction?.replied) return interaction.followUp(safePayload(payload));
  return safeReply(interaction, payload);
}

export async function requireGuild(interaction) {
  if (interaction?.guildId || interaction?.guild?.id) return true;
  await safeReply(interaction, { content: '❌ 此命令只能在服务器中使用。', flags: 64 });
  return false;
}

export function hasManageGuild(interaction) {
  return Boolean(interaction?.memberPermissions?.has?.(PermissionFlagsBits.ManageGuild)
    || interaction?.member?.permissions?.has?.(PermissionFlagsBits.ManageGuild));
}

export function hasConfiguredDJRole(interaction, settings = null) {
  const roleId = settings?.djRole || GuildSettings.get(interaction?.guildId || interaction?.guild?.id).djRole;
  if (!roleId) return false;
  return Boolean(interaction?.member?.roles?.cache?.has?.(roleId)
    || interaction?.member?.roles?.cache?.some?.(role => role?.id === roleId));
}

export function hasMusicPermission(interaction, { manageGuildOnly = false } = {}) {
  if (hasManageGuild(interaction)) return true;
  if (manageGuildOnly) return false;
  const settings = GuildSettings.get(interaction?.guildId || interaction?.guild?.id);
  return !settings.djRole || hasConfiguredDJRole(interaction, settings);
}

export async function requireMusicAccess(interaction, {
  requireVoice = false,
  requireBotInVoice = false,
  manageGuildOnly = false,
} = {}) {
  if (!(await requireGuild(interaction))) return false;
  if (!hasMusicPermission(interaction, { manageGuildOnly })) {
    await respondInteraction(interaction, {
      content: manageGuildOnly
        ? '❌ 只有拥有管理服务器权限的成员可以修改服务器设置。'
        : '❌ 只有 DJ 角色或拥有管理服务器权限的成员可以执行此操作。',
      flags: 64,
    });
    return false;
  }
  if (requireVoice && !(await requireVoiceContext(interaction, { requireBotInVoice }))) return false;
  return true;
}

export function getMemberVoiceChannel(interaction) {
  return interaction?.member?.voice?.channel || null;
}

export function getBotMember(interaction) {
  return interaction?.guild?.members?.me
    || interaction?.guild?.members?.cache?.get(interaction?.client?.user?.id)
    || interaction?.client?.user
    || null;
}

export function getBotVoiceChannel(interaction) {
  return getBotMember(interaction)?.voice?.channel || null;
}

export function inspectVoiceContext(interaction, { checkPermissions = true, requireBotInVoice = false } = {}) {
  const voiceChannel = getMemberVoiceChannel(interaction);
  if (!voiceChannel) {
    return { ok: false, message: '❌ 你需要先加入语音频道！' };
  }

  const botVoiceChannel = getBotVoiceChannel(interaction);
  if (requireBotInVoice && !botVoiceChannel) {
    return { ok: false, message: '❌ 我当前不在语音频道。' };
  }
  if (botVoiceChannel && botVoiceChannel.id !== voiceChannel.id) {
    return { ok: false, message: '❌ 你需要和我在同一个语音频道！' };
  }

  if (checkPermissions) {
    const permissions = voiceChannel.permissionsFor?.(getBotMember(interaction));
    if (!permissions?.has?.('ViewChannel')
      || !permissions.has('Connect')
      || !permissions.has('Speak')) {
      return { ok: false, message: '❌ 我没有权限加入或在该语音频道说话！' };
    }
  }

  return { ok: true, voiceChannel, botVoiceChannel };
}

export async function requireVoiceContext(interaction, options) {
  const context = inspectVoiceContext(interaction, options);
  if (!context.ok) {
    await respondInteraction(interaction, { content: context.message, flags: 64 });
    return null;
  }
  return context;
}

export async function requireSameVoiceChannel(interaction, options) {
  return requireVoiceContext(interaction, options);
}
