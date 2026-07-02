import { randomUUID } from 'crypto';
import { Playlist } from '../models/database.js';

const PENDING_TTL_MS = 5 * 60 * 1000;
const pendingPlans = new Map(); // token -> { plan, userId, createdAt }

function purgeExpired() {
  const now = Date.now();
  for (const [token, entry] of pendingPlans) {
    if (now - entry.createdAt > PENDING_TTL_MS) pendingPlans.delete(token);
  }
}

export function storePendingPlan(plan, userId) {
  purgeExpired();
  const token = randomUUID().slice(0, 8);
  pendingPlans.set(token, { plan, userId, createdAt: Date.now() });
  return token;
}

export function takePendingPlan(token, userId) {
  purgeExpired();
  const entry = pendingPlans.get(token);
  if (!entry) return { ok: false, reason: 'expired' };
  if (entry.userId !== userId) return { ok: false, reason: 'wrong-user' };
  pendingPlans.delete(token);
  return { ok: true, plan: entry.plan };
}

export function discardPendingPlan(token) {
  pendingPlans.delete(token);
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

  // 删除整个歌单
  if (plan.action === 'delete') {
    const ok = Playlist.delete(plan.guildId, plan.playlistName);
    summary.deleted = Boolean(ok);
    if (!ok) summary.error = '播放列表不存在或已被删除。';
    return summary;
  }

  // 新建
  let playlist = Playlist.get(plan.guildId, plan.playlistName);
  if (!playlist && plan.create) {
    const playlistId = Playlist.create(plan.guildId, plan.userId, plan.playlistName);
    if (playlistId === 'limit') {
      summary.error = '播放列表数量已达上限（25 个）！';
      return summary;
    }
    if (playlistId) {
      summary.created = true;
      playlist = Playlist.get(plan.guildId, plan.playlistName);
    } else {
      playlist = Playlist.get(plan.guildId, plan.playlistName);
    }
  }

  if (!playlist) {
    summary.error = `播放列表 ${plan.playlistName} 不存在。`;
    return summary;
  }

  // 重命名
  if (plan.renameTo && plan.renameTo !== playlist.name) {
    const renameResult = Playlist.rename(plan.guildId, playlist.name, plan.renameTo);
    if (renameResult === false) {
      summary.error = `无法重命名，播放列表 ${plan.renameTo} 已存在。`;
      return summary;
    }
    if (renameResult) {
      summary.renamedFrom = playlist.name;
      playlist = Playlist.get(plan.guildId, plan.renameTo);
    }
  }

  // 清空
  if (plan.clear) {
    summary.cleared = Playlist.clearSongs(playlist.id) || 0;
  }

  // 移除（清空时跳过）
  if (!plan.clear && plan.removeSongs?.length > 0) {
    const ids = plan.removeSongs.map(song => song.id).filter(Boolean);
    if (ids.length > 0) {
      const removedCount = Playlist.removeSongs(playlist.id, ids) || 0;
      summary.removed = plan.removeSongs.slice(0, removedCount);
    }
  }

  // 新增
  if (plan.addSongs?.length > 0) {
    for (const song of plan.addSongs) {
      const addResult = Playlist.addSong(playlist.id, song);
      if (addResult === 'limit') break;
      if (addResult) summary.added.push(song);
    }
  }

  summary.finalName = playlist.name;
  summary.finalCount = Playlist.getSongs(playlist.id).length;
  return summary;
}

function listTitles(songs, limit = 10) {
  return songs.slice(0, limit).map((song, index) => `${index + 1}. ${song.title}`).join('\n');
}

function truncate(message, limit = 1900) {
  if (message.length <= limit) return message;
  return `${message.slice(0, limit - 20)}\n...内容过长已截断`;
}

// 构建执行后的结果消息（命令直接执行和按钮确认共用）
export function buildResultMessage(plan, summary) {
  if (summary.error) return `❌ ${summary.error}`;
  if (summary.deleted) {
    return `✅ 已删除播放列表：**${plan.playlistName}**${plan.reason ? `\n\nAI 理解：${plan.reason}` : ''}`;
  }

  const name = summary.finalName || plan.playlistName;
  const title = summary.renamedFrom ? `**${summary.renamedFrom}** → **${name}**` : `**${name}**`;
  const lines = [`✅ 已处理歌单：${title}`];
  if (summary.created) lines.push('新建：是');
  if (plan.clear) lines.push(`清空：${summary.cleared} 首`);
  if (summary.removed.length > 0) lines.push(`删除：${summary.removed.length} 首`);
  if (summary.added.length > 0) lines.push(`新增：${summary.added.length} 首`);
  lines.push(`当前共：${summary.finalCount} 首`);
  if (plan.reason) lines.push(`\nAI 理解：${plan.reason}`);
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
  const name = plan.playlistName;

  if (plan.action === 'delete') {
    lines.push(`🗑️ **删除整个歌单：${name}**`);
  } else {
    if (plan.create) lines.push(`➕ 新建歌单：**${name}**`);
    if (plan.renameTo) lines.push(`✏️ 重命名：**${name}** → **${plan.renameTo}**`);
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

  if (plan.reason) lines.push(`\nAI 理解：${plan.reason}`);
  lines.push('\n点击 ✅ 确认执行，或 ❌ 取消。（5 分钟内有效）');
  return truncate(lines.join('\n'));
}
