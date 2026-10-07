import { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { Playlist } from '../models/database.js';
import { addSongsToPlayback } from '../utils/playback.js';
import {
  parseAIPlaylistIntent,
  resolveContent,
  findSongsToRemove,
  getAIPlaylistConfigStatus,
  normalizeAddCount,
} from '../utils/aiPlaylist.js';
import {
  storePendingPlan,
  planIsDestructive,
  commitPlaylistPlan,
  buildResultMessage,
  buildPreviewMessage,
} from '../utils/aiPlaylistPlan.js';
import {
  protectInteraction,
  requireGuild,
  requireMusicAccess,
  safeEditReply,
  safeReply,
  safeText,
} from '../utils/commandSafety.js';
import { looksLikeUrl, parseBilibiliInput, parseYouTubeUrl } from '../utils/urlAllowlist.js';

function hasOwnerPermission(playlist, userId) {
  return playlist?.userId === userId;
}

function shuffleSongs(songs) {
  const shuffled = [...songs];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function playlistChoices(guildId, focused) {
  const query = String(focused || '').toLowerCase().trim();
  return Playlist.getAll(guildId)
    .filter(playlist => !query || playlist.name.toLowerCase().includes(query))
    .slice(0, 25)
    .map(playlist => ({ name: safeText(playlist.name, 100), value: playlist.name.slice(0, 100) }));
}

export const data = new SlashCommandBuilder()
  .setName('playlist')
  .setDescription('播放列表管理')
  .addSubcommand(subcommand =>
    subcommand
      .setName('create')
      .setDescription('创建新播放列表')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('播放列表名称')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('delete')
      .setDescription('删除播放列表')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('播放列表名称')
          .setAutocomplete(true)
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('list')
      .setDescription('显示所有播放列表')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('add')
      .setDescription('添加歌曲到播放列表')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('播放列表名称')
          .setAutocomplete(true)
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('url')
          .setDescription('YouTube 或 Bilibili 链接')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('show')
      .setDescription('显示播放列表内容')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('播放列表名称')
          .setAutocomplete(true)
          .setRequired(true)
      )
      .addIntegerOption(option =>
        option.setName('page')
          .setDescription('页码')
          .setMinValue(1)
          .setRequired(false)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('play')
      .setDescription('播放播放列表')
      .addStringOption(option =>
        option.setName('name')
          .setDescription('播放列表名称')
          .setAutocomplete(true)
          .setRequired(true)
      )
      .addBooleanOption(option =>
        option.setName('shuffle')
          .setDescription('是否随机播放这个播放列表')
          .setRequired(false)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('ai')
      .setDescription('用普通语言创建或修改播放列表')
      .addStringOption(option =>
        option.setName('prompt')
          .setDescription('例如：新建一个晚上开车听的粤语歌单，放 30 首')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('name')
          .setDescription('可选：选择要修改的播放列表，不选则由 AI 从描述中判断')
          .setAutocomplete(true)
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option.setName('count')
          .setDescription('最多添加几首歌，默认 20，最多 100')
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(false)
      )
  );

export async function autocomplete(interaction) {
  if (!interaction.guildId) return interaction.respond([]);
  const focused = interaction.options.getFocused();
  await interaction.respond(playlistChoices(interaction.guild.id, focused));
}

export async function execute(interaction) {
  protectInteraction(interaction);
  if (!(await requireGuild(interaction))) return;
  const subcommand = interaction.options.getSubcommand();
  const guildId = interaction.guild.id;
  const userId = interaction.user.id;

  switch (subcommand) {
    case 'create': {
      const name = interaction.options.getString('name');
      const playlistId = Playlist.create(guildId, userId, name);
      
      if (playlistId === 'limit') {
        await interaction.reply('❌ 播放列表数量已达上限（25 个）！');
      } else if (playlistId === 'invalid') {
        await interaction.reply('❌ 播放列表名称无效（长度 1-100，不能包含控制字符）。');
      } else if (playlistId) {
        await interaction.reply(`✅ 已创建播放列表: **${safeText(name, 100)}**`);
      } else {
        await interaction.reply('❌ 播放列表已存在！');
      }
      break;
    }

    case 'delete': {
      const name = interaction.options.getString('name');
      const playlist = Playlist.get(guildId, name);
      if (!playlist) {
        await interaction.reply('❌ 播放列表不存在！');
        break;
      }
      if (playlist.userId !== userId) {
        await interaction.reply('❌ 只有播放列表的创建者才能删除它！');
        break;
      }
      Playlist.delete(guildId, name);
      await interaction.reply(`✅ 已删除播放列表: **${safeText(name, 100)}**`);
      break;
    }

    case 'list': {
      const playlists = Playlist.getAll(guildId);
      
      if (playlists.length === 0) {
        return interaction.reply('📭 没有播放列表！');
      }

      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle('📁 播放列表')
        .setDescription(
          playlists.map((pl, index) =>
            `**${index + 1}.** ${pl.name} (创建于 ${new Date(pl.createdAt || pl.created_at).toLocaleDateString()})`
          ).join('\n')
        );

      await interaction.reply({ embeds: [embed] });
      break;
    }

    case 'add': {
      await interaction.deferReply({ flags: 64 });
      try {
        const name = interaction.options.getString('name');
        const url = interaction.options.getString('url');
        
        const playlist = Playlist.get(guildId, name);
        if (!playlist) {
          return interaction.editReply('❌ 播放列表不存在！');
        }

        const { Bilibili } = await import('../utils/bilibili.js');
        const { YouTube } = await import('../utils/youtube.js');
        const bilibili = parseBilibiliInput(url);
        const youtube = parseYouTubeUrl(url, { allowPlaylist: false });
        if (!bilibili && !youtube) {
          return interaction.editReply(looksLikeUrl(url)
            ? '❌ 已拒绝该外部地址，只支持严格的 YouTube 单视频或 Bilibili 视频链接。'
            : '❌ 只支持严格的 YouTube 单视频或 Bilibili 视频链接。');
        }
        const video = bilibili
          ? await Bilibili.getVideoInfo(bilibili.canonicalUrl)
          : await YouTube.getVideoInfo(youtube.canonicalUrl);
        
        if (!video) {
          return interaction.editReply('❌ 无法获取视频信息！');
        }

        const addResult = Playlist.addSong(playlist.id, video);
        if (addResult === 'limit') {
          return interaction.editReply('❌ 播放列表歌曲数量已达上限（200 首）！');
        }
        await interaction.editReply(`✅ 已添加 **${safeText(video.title, 500)}** 到播放列表 **${safeText(name, 100)}**`);
      } catch (error) {
        console.error('[Playlist] add error:', error.message);
        await interaction.editReply('❌ 添加歌曲失败，请稍后再试。');
      }
      break;
    }

    case 'show': {
      const name = interaction.options.getString('name');
      const page = interaction.options.getInteger('page') || 1;
      const playlist = Playlist.get(guildId, name);
      
      if (!playlist) {
        return interaction.reply('❌ 播放列表不存在！');
      }

      const songs = Playlist.getSongs(playlist.id);
      
      if (songs.length === 0) {
        return interaction.reply('📭 播放列表为空！');
      }

      const songsPerPage = 10;
      const totalPages = Math.max(1, Math.ceil(songs.length / songsPerPage));
      if (page > totalPages) {
        return interaction.reply(`❌ 页码超出范围！总共 ${totalPages} 页`);
      }

      const startIndex = (page - 1) * songsPerPage;
      const currentSongs = songs.slice(startIndex, startIndex + songsPerPage);

      const embed = new EmbedBuilder()
        .setColor(0x0099ff)
        .setTitle(`📁 播放列表: ${name}`)
        .setDescription(
          currentSongs.map((song, index) =>
            `**${startIndex + index + 1}.** ${song.title}\n` +
            `   时长: ${song.duration || 'N/A'}`
          ).join('\n\n')
        )
        .setFooter({ text: `第 ${page}/${totalPages} 页 | 共 ${songs.length} 首歌曲` });

      await interaction.reply({ embeds: [embed] });
      break;
    }

    case 'play': {
      if (!(await requireMusicAccess(interaction, { requireVoice: true }))) return;
      await interaction.deferReply({ flags: 64 });
      try {
        const name = interaction.options.getString('name');
        const shuffle = interaction.options.getBoolean('shuffle') || false;
        const playlist = Playlist.get(guildId, name);
        
        if (!playlist) {
          return interaction.editReply('❌ 播放列表不存在！');
        }

        const songs = shuffle ? shuffleSongs(Playlist.getSongs(playlist.id)) : [...Playlist.getSongs(playlist.id)];
        
        if (songs.length === 0) {
          return interaction.editReply('📭 播放列表为空！');
        }

        await addSongsToPlayback(interaction, songs, {
          editReply: true,
          successNote: shuffle ? `随机播放歌单：${name}` : '',
        });
      } catch (error) {
        console.error('[Playlist] play error:', error.message);
        await interaction.editReply('❌ 播放列表播放失败，请稍后再试。');
      }
      break;
    }

    case 'ai': {
      await interaction.deferReply({ flags: 64 });

      const prompt = interaction.options.getString('prompt');
      const selectedName = interaction.options.getString('name');
      const count = normalizeAddCount(interaction.options.getInteger('count') || 20);
      const aiConfig = getAIPlaylistConfigStatus();

      if (!aiConfig.ok) {
        return interaction.editReply(
          `❌ AI 歌单未启用：${aiConfig.reason}。\n` +
          '请在 .env 设置 AI_ENABLED=true 和真实 AI_API_KEY 后重启机器人。'
        );
      }

      await interaction.editReply(count > 40
        ? `🤖 正在理解你的歌单需求，并准备最多添加 ${count} 首歌，可能需要一段时间...`
        : '🤖 正在理解你的歌单需求...'
      );

      try {
        const existingPlaylists = Playlist.getAll(guildId);
        const intent = await parseAIPlaylistIntent(prompt, { count, playlists: existingPlaylists, selectedName });
        if (!intent) {
          return interaction.editReply('❌ AI 暂时无法理解这条请求（可能是 AI 服务不可用），请稍后再试。');
        }

        // 解析目标歌单（不立即创建，先构建 plan）
        const targetName = intent.targetPlaylist || intent.suggestedName;
        const existing = intent.targetPlaylist ? Playlist.get(guildId, intent.targetPlaylist) : null;
        const wantsSongs = intent.content.kind !== 'none';
        const shouldCreate = !existing && (intent.action === 'create' || (wantsSongs && Boolean(intent.suggestedName)));

        if (!existing && !shouldCreate) {
          const names = existingPlaylists.map(p => `• ${p.name}`).join('\n');
          const hint = names
            ? `请用 \`name\` 选项指定一个歌单，或在描述里说“新建一个叫…的歌单”。\n现有歌单：\n${names}`
            : '你还没有歌单。请在描述里说“新建一个叫…的歌单”，或先用 `/playlist create` 创建。';
          return interaction.editReply(`❓ 没找到要操作的歌单。${intent.reason ? `\nAI 理解：${intent.reason}` : ''}\n\n${hint}`);
        }

        const targetPlaylist = existing;
        const effectiveName = existing ? existing.name : targetName;
        const targetSnapshot = existing ? Playlist.getSnapshot(guildId, existing.name) : null;

        // 破坏性操作权限校验（仅对已存在歌单有意义；新建的归当前用户）
        const destructiveIntent = intent.action === 'delete'
          || intent.action === 'clear'
          || intent.action === 'rename'
          || intent.remove.byIndexes.length > 0
          || intent.remove.byTitleKeywords.length > 0;

        if (destructiveIntent && targetPlaylist && !hasOwnerPermission(targetPlaylist, userId)) {
          return interaction.editReply('❌ 只有播放列表创建者可以删除、清空、重命名或移除歌曲。你仍然可以让 AI 追加歌曲。');
        }

        // 预先计算待删歌曲
        let removeSongs = [];
        if (targetPlaylist && intent.action !== 'clear' && intent.action !== 'delete'
          && (intent.remove.byIndexes.length > 0 || intent.remove.byTitleKeywords.length > 0)) {
          const currentSongs = Playlist.getSongs(targetPlaylist.id);
          removeSongs = findSongsToRemove(currentSongs, intent.remove)
            .map(song => ({ id: song.id, title: song.title }));
        }

        // 预先解析待加歌曲
        let resolution = { songs: [], missing: [], source: 'search', estimated: false };
        if (wantsSongs && intent.action !== 'delete') {
          await interaction.editReply(`🔍 已理解歌单 **${safeText(effectiveName, 100)}**，正在从音乐源获取最多 ${count} 首歌...`);
          const existingSongs = targetPlaylist ? Playlist.getSongs(targetPlaylist.id) : [];
          resolution = await resolveContent(intent.content, existingSongs, count);
        }

        if (targetSnapshot) {
          const latestSnapshot = Playlist.getSnapshot(guildId, targetSnapshot.name);
          if (!latestSnapshot || latestSnapshot.id !== targetSnapshot.id || latestSnapshot.revision !== targetSnapshot.revision) {
            return interaction.editReply('❌ 播放列表在处理期间已发生变化，请重新执行 /playlist ai。');
          }
        }

        const plan = {
          guildId,
          userId,
          action: intent.action,
          playlistName: effectiveName,
          playlistId: targetSnapshot?.id || null,
          expectedRevision: targetSnapshot?.revision ?? null,
          requireOwner: destructiveIntent,
          create: shouldCreate,
          renameTo: intent.action === 'rename' ? intent.renameTo : null,
          clear: intent.action === 'clear',
          removeSongs,
          addSongs: resolution.songs,
          resolution: { source: resolution.source, estimated: resolution.estimated },
          reason: intent.reason,
          expectedSongs: wantsSongs,
        };

        // 破坏性操作 → 预览 + 确认按钮；否则直接执行
        if (planIsDestructive(plan)) {
          const token = storePendingPlan(plan, userId, guildId);
          if (!token) return interaction.editReply('❌ 当前确认操作过多，请稍后再试。');
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`aiplaylist:confirm:${token}`).setLabel('确认').setStyle(ButtonStyle.Danger).setEmoji('✅'),
            new ButtonBuilder().setCustomId(`aiplaylist:cancel:${token}`).setLabel('取消').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
          );
          return interaction.editReply({ content: buildPreviewMessage(plan), components: [row] });
        }

        const summary = commitPlaylistPlan(plan);
        await interaction.editReply({ content: buildResultMessage(plan, summary), components: [] });
      } catch (error) {
        console.error('[Playlist] ai error:', error);
        await interaction.editReply('❌ AI 歌单处理失败，请稍后再试。');
      }
      break;
    }
  }
}
