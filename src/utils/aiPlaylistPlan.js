import { randomBytes } from 'crypto';
import { Playlist } from '../models/database.js';
import { safeText } from './commandSafety.js';

const PENDING_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_PLANS = Math.max(10, Math.min(5000, Number.parseInt(process.env.AI_PLAYLIST_PENDING_MAX || '1000', 10) || 1000));
const MAX_PENDING_PER_OWNER = Math.max(1, Math.min(50, Number.parseInt(process.env.AI_PLAYLIST_PENDING_PER_OWNER || '5', 10) || 5));
const pendingPlans = new Map(); // token -> { plan, userId, guildId, createdAt }

function purgeExpired(now = Date.now()) {
  for (const [token, entry] of pendingPlans) {
    if (now - entry.createdAt >= PENDING_TTL_MS) pendingPlans.delete(token);
  }
}

export function storePendingPlan(plan, userId, guildId = plan?.guildId) {
  purgeExpired();
  const ownerId = String(userId || '');
  const ownerGuildId = String(guildId || '');
  if (!plan || !ownerId || !ownerGuildId || String(plan.userId || '') !== ownerId || String(plan.guildId || '') !== ownerGuildId) {
    return null;
  }

  if (pendingPlans.size >= MAX_PENDING_PLANS) return null;
  let ownerPending = 0;
  for (const entry of pendingPlans.values()) {
    if (entry.userId === ownerId && entry.guildId === ownerGuildId) ownerPending += 1;
  }
  if (ownerPending >= MAX_PENDING_PER_OWNER) return null;

  const token = randomBytes(32).toString('base64url');
  pendingPlans.set(token, {
    plan: structuredClone(plan),
    userId: ownerId,
    guildId: ownerGuildId,
    createdAt: Date.now(),
  });
  return token;
}

export function takePendingPlan(token, userId, guildId) {
  purgeExpired();
  const entry = pendingPlans.get(token);
  if (!entry) return { ok: false, reason: 'expired' };
  if (entry.userId !== String(userId || '')) return { ok: false, reason: 'wrong-user' };
  if (entry.guildId !== String(guildId || '')) return { ok: false, reason: 'wrong-guild' };
  pendingPlans.delete(token);
  return { ok: true, plan: entry.plan };
}

export function discardPendingPlan(token, userId, guildId) {
  purgeExpired();
  const entry = pendingPlans.get(token);
  if (!entry) return { ok: false, reason: 'expired' };
  if (entry.userId !== String(userId || '')) return { ok: false, reason: 'wrong-user' };
  if (entry.guildId !== String(guildId || '')) return { ok: false, reason: 'wrong-guild' };
  pendingPlans.delete(token);
  return { ok: true };
}

/**
 * 一个 plan 描述将要执行的全部歌单变更：
 * {
 *   guildId, userId,
 *   action,                 // add | create | clear | remove | rename | delete
 *   playlistName,           // 现有歌单名（操作目标）；create 时为新名
 *   create: boolean,        // 是否需要新建
 *   renameTo: string|null,
 *   clear: boolean,
 *   removeSongs: [{id,title}],   // 预先算好的待删歌曲
 *   addSongs: [song...],         // 预先解析好的待加歌曲
 *   resolution: { source, estimated },
 *   reason: string,
 * }
 * 是否需要确认：删除/清空/重命名/移除歌曲。
 */
export function planIsDestructive(plan) {
  return Boolean(plan.action === 'delete' || plan.clear || plan.renameTo || (plan.removeSongs && plan.removeSongs.length > 0));
}

/**
 * 执行 plan 的全部数据库变更，返回结果摘要。
 * 假设权限/存在性已在构建 plan 时校验过；这里做最小校验防止 TOCTOU。
 */
export function commitPlaylistPlan(plan) {
  const summary = { created: false, renamedFrom: null, cleared: 0, removed: [], added: [], deleted: false, error: null };

  const result = Playlist.applyConditionalPlan({
    guildId: plan.guildId,
    userId: plan.userId,
    playlistId: plan.playlistId,
    playlistName: plan.playlistName,
    expectedRevision: plan.expectedRevision,
    requireOwner: plan.requireOwner === true,
    action: plan.action,
    create: plan.create,
    renameTo: plan.renameTo,
    clear: plan.clear,
    removeSongIds: plan.removeSongs?.map(song => song.id).filter(Boolean),
    addSongs: plan.addSongs,
  });

  if (!result.ok) {
    summary.error = {
      'stale': '播放列表在预览后已发生变化，请重新执行 /playlist ai。',
      'wrong-guild': '播放列表不属于当前服务器。',
      'not-owner': '只有播放列表创建者可以执行这个操作。',
      'not-found': '播放列表不存在或已被删除。',
      'name-conflict': '目标播放列表名称已存在。',
      'playlist-limit': '播放列表数量已达上限（25 个）！',
      'invalid-name': '播放列表名称无效。',
    }[result.reason] || '播放列表操作无法执行。';
    return summary;
  }

  summary.created = Boolean(result.created);
  summary.renamedFrom = result.renamedFrom || null;
  summary.cleared = result.cleared || 0;
  summary.removed = result.removed || [];
  summary.added = result.added || [];
  summary.deleted = Boolean(result.deleted);
  summary.finalName = result.finalName;
  summary.finalCount = result.finalCount;
  return summary;
}

function listTitles(songs, limit = 10) {
  return songs.slice(0, limit).map((song, index) => `${index + 1}. ${safeText(song?.title || '未命名歌曲', 240)}`).join('\n');
}

function truncate(message, limit = 1900) {
  return safeText(message, limit);
}

// 构建执行后的结果消息（命令直接执行和按钮确认共用）
export function buildResultMessage(plan, summary) {
  if (summary.error) return `❌ ${summary.error}`;
  if (summary.deleted) {
    return `✅ 已删除播放列表：**${safeText(plan.playlistName, 200)}**${plan.reason ? `\n\nAI 理解：${safeText(plan.reason, 400)}` : ''}`;
  }

  const name = summary.finalName || plan.playlistName;
  const title = summary.renamedFrom
    ? `**${safeText(summary.renamedFrom, 200)}** → **${safeText(name, 200)}**`
    : `**${safeText(name, 200)}**`;
  const lines = [`✅ 已处理歌单：${title}`];
  if (summary.created) lines.push('新建：是');
  if (plan.clear) lines.push(`清空：${summary.cleared} 首`);
  if (summary.removed.length > 0) lines.push(`删除：${summary.removed.length} 首`);
  if (summary.added.length > 0) lines.push(`新增：${summary.added.length} 首`);
  lines.push(`当前共：${summary.finalCount} 首`);
  if (plan.reason) lines.push(`\nAI 理解：${safeText(plan.reason, 400)}`);
  if (plan.resolution?.source === 'music-album' && summary.added.length > 0) {
    lines.push('🎯 曲目来自音乐源的官方专辑/演唱会列表。');
  }
  if (plan.resolution?.estimated && summary.added.length > 0) {
    lines.push('⚠️ 未找到官方曲目表，以下为 AI 推测的歌曲，可能不完全准确。');
  }
  if (summary.added.length > 0) {
    lines.push(`\n新增歌曲：\n${listTitles(summary.added)}`);
    if (summary.added.length > 10) lines.push(`...还有 ${summary.added.length - 10} 首`);
  }
  if (summary.removed.length > 0) {
    lines.push(`\n删除歌曲：\n${listTitles(summary.removed)}`);
    if (summary.removed.length > 10) lines.push(`...还有 ${summary.removed.length - 10} 首`);
  }
  if (summary.added.length === 0 && plan.addSongs?.length === 0 && plan.expectedSongs) {
    lines.push('\n⚠️ 没有找到可添加的新歌曲，可能是音乐源无结果或歌曲已存在。');
  }

  return truncate(lines.join('\n'));
}

// 构建确认预览消息
export function buildPreviewMessage(plan) {
  const lines = ['⚠️ 这个操作会改动你的歌单，请确认：', ''];
  const name = safeText(plan.playlistName, 200);

  if (plan.action === 'delete') {
    lines.push(`🗑️ **删除整个歌单：${name}**`);
  } else {
    if (plan.create) lines.push(`➕ 新建歌单：**${name}**`);
    if (plan.renameTo) lines.push(`✏️ 重命名：**${name}** → **${safeText(plan.renameTo, 200)}**`);
    if (plan.clear) lines.push(`🧹 清空歌单全部歌曲`);
    if (plan.removeSongs?.length > 0) {
      lines.push(`➖ 移除 ${plan.removeSongs.length} 首：`);
      lines.push(listTitles(plan.removeSongs, 15));
      if (plan.removeSongs.length > 15) lines.push(`...还有 ${plan.removeSongs.length - 15} 首`);
    }
    if (plan.addSongs?.length > 0) {
      lines.push(`🎵 新增 ${plan.addSongs.length} 首：`);
      lines.push(listTitles(plan.addSongs, 15));
      if (plan.addSongs.length > 15) lines.push(`...还有 ${plan.addSongs.length - 15} 首`);
    }
  }

  if (plan.reason) lines.push(`\nAI 理解：${safeText(plan.reason, 400)}`);
  lines.push('\n点击 ✅ 确认执行，或 ❌ 取消。（5 分钟内有效）');
  return truncate(lines.join('\n'));
}
