import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { musicQueue, MusicPlayer } from '../utils/player.js';
import { refreshNowPlayingPanel } from '../utils/playerPanel.js';
import { describeStyle, ensureRadioQueue, invalidateRadioGeneration, refreshRadioSeed } from '../utils/radio.js';
import { savePlaybackState } from '../utils/playbackState.js';
import { versionPreferenceLabel } from '../utils/versionPreference.js';
import { requireGuild, requireMusicAccess } from '../utils/commandSafety.js';

const GENRES = [
  ['mandopop', '华语流行'],
  ['cantopop', '粤语流行'],
  ['pop', '欧美流行'],
  ['kpop', 'K-pop'],
  ['jpop', 'J-pop'],
  ['rock', '摇滚'],
  ['hiphop', '嘻哈'],
  ['rnb', 'R&B'],
  ['edm', 'EDM'],
  ['lofi', 'Lo-fi'],
  ['jazz', '爵士'],
  ['anime', '动漫'],
];

const ERAS = ['any', '70s', '80s', '90s', '2000s', '2010s', '2020s', 'latest'];
const LANGUAGES = [
  ['any', '不限'],
  ['chinese', '中文'],
  ['cantonese', '粤语'],
  ['english', '英文'],
  ['japanese', '日文'],
  ['korean', '韩文'],
];
const MOODS = [
  ['any', '不限'],
  ['chill', '放松'],
  ['happy', '开心'],
  ['sad', '伤感'],
  ['party', '派对'],
  ['focus', '专注'],
  ['romantic', '浪漫'],
  ['energetic', '热血'],
];

function addChoices(option, choices) {
  for (const choice of choices) {
    if (Array.isArray(choice)) {
      option.addChoices({ name: choice[1], value: choice[0] });
    } else {
      option.addChoices({ name: choice === 'any' ? '不限' : choice, value: choice });
    }
  }
  return option;
}

function resolveStyleValue(interaction, name, currentValue) {
  const value = interaction.options.getString(name);
  if (value === null) return currentValue ?? null;
  return value === 'any' ? null : value;
}

function optionWasSet(interaction, name) {
  return interaction.options.getString(name) !== null;
}

function hasExplicitStyle(style = {}) {
  return Boolean(style.genre || style.era || style.language || style.mood);
}

function noRecommendationMessage(serverQueue) {
  return '✅ 自动续播已开启，但暂时没有找到可播放推荐。\n' +
    `当前风格：${describeStyle(serverQueue.radio.currentStyle)}\n` +
    `版本偏好：${versionPreferenceLabel(serverQueue.versionPreference || 'any')}\n` +
    '建议尝试 /radio style 调整风格，或 /version any 放宽版本偏好。';
}

function manualPlaybackRadioMessage(prefix, generatedCount, serverQueue) {
  if (generatedCount > 0) {
    return `${prefix}，已生成 ${generatedCount} 首推荐。手动队列结束后会自动续播。`;
  }
  return `${prefix}，但暂时没有生成到推荐。当前播放如果是长视频或非音乐内容，将不会作为推荐种子；已按当前风格「${describeStyle(serverQueue.radio.currentStyle)}」尝试生成。`;
}

export function buildRadioCommandData(name = 'radio', description = '自动续播和风格电台') {
  return new SlashCommandBuilder()
  .setName(name)
  .setDescription(description)
  .addSubcommand(subcommand =>
    subcommand
      .setName('start')
      .setDescription('开启自动续播')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('stop')
      .setDescription('关闭自动续播')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('status')
      .setDescription('查看自动续播状态')
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('style')
      .setDescription('设置自动续播风格，下一首自动续播生效')
      .addStringOption(option => addChoices(option.setName('genre').setDescription('风格').setRequired(false), GENRES))
      .addStringOption(option => addChoices(option.setName('era').setDescription('年代').setRequired(false), ERAS))
      .addStringOption(option => addChoices(option.setName('language').setDescription('语言').setRequired(false), LANGUAGES))
      .addStringOption(option => addChoices(option.setName('mood').setDescription('心情').setRequired(false), MOODS))
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('autodetect')
      .setDescription('开关 AI 自动风格识别')
      .addBooleanOption(option =>
        option.setName('enabled')
          .setDescription('是否开启')
          .setRequired(true)
      )
  )
  .addSubcommand(subcommand =>
    subcommand
      .setName('reset')
      .setDescription('清空自动续播缓存并重新生成')
  );
}

export const data = buildRadioCommandData();

export async function execute(interaction) {
  const subcommand = interaction.options.getSubcommand();
  if (subcommand === 'status') {
    if (!(await requireGuild(interaction))) return;
  } else if (!(await requireMusicAccess(interaction, {
    requireVoice: subcommand === 'start' || subcommand === 'reset',
  }))) return;
  const serverQueue = subcommand === 'start'
    ? musicQueue.get(interaction.guild.id)
    : musicQueue.peek(interaction.guild.id);

  if (!serverQueue) {
    if (subcommand === 'status') {
      const embed = new EmbedBuilder()
        .setColor(0x999999)
        .setTitle('📻 自动续播状态')
        .addFields(
          { name: '状态', value: '关闭', inline: true },
          { name: 'AI 自动识别', value: '关闭', inline: true },
          { name: '当前风格', value: describeStyle({}), inline: false }
        );
      return interaction.reply({ embeds: [embed] });
    }
    return interaction.reply({ content: '❌ 当前没有活跃的播放队列，请先使用 /play 播放音乐。', flags: 64 });
  }

  if (subcommand !== 'status') {
    serverQueue.textChannel = interaction.channel;
    serverQueue.textChannelId = interaction.channel.id;
  }

  if (subcommand === 'start') {
    await interaction.deferReply();
    try {
      MusicPlayer.clearIdleLeaveTimer(serverQueue);
      serverQueue.queueEnded = false;
      serverQueue.radio.enabled = true;
      serverQueue.radioFailureCount = 0;
      serverQueue.suppressRadioUntilManualPlay = false;
      refreshRadioSeed(serverQueue);
      savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });

      let generatedCount = 0;
      if (serverQueue.radioQueue.length < 2) {
        generatedCount = await ensureRadioQueue(serverQueue, 5);
      }

      if (MusicPlayer.isManualPlaybackActive(serverQueue)) {
        savePlaybackState(interaction.guild.id, serverQueue);
        await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
        return interaction.editReply(manualPlaybackRadioMessage('✅ 自动续播已开启', generatedCount, serverQueue));
      }

      if (!serverQueue.playing && serverQueue.radioQueue.length > 0) {
        const voiceChannel = interaction.member.voice.channel;
        if (!voiceChannel) {
          return interaction.editReply('✅ 已开启自动续播。加入语音频道并使用 /play 或 /radio reset 后我会开始播放。');
        }
        if (!serverQueue.connection) {
          serverQueue.connection = await MusicPlayer.joinVoice(
            voiceChannel,
            interaction.guild.id,
            interaction.guild.voiceAdapterCreator
          );
        }
        await MusicPlayer.playSong(interaction.guild.id, interaction.channel);
      }

      savePlaybackState(interaction.guild.id, serverQueue);
      await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
      if (serverQueue.radioQueue.length === 0 && generatedCount === 0) {
        return interaction.editReply(noRecommendationMessage(serverQueue));
      }
      return interaction.editReply(`✅ 自动续播已开启。当前风格：${describeStyle(serverQueue.radio.currentStyle)}`);
    } catch (error) {
      console.error('[Radio] start error:', error.message);
      return interaction.editReply('❌ 开启自动续播失败，请稍后再试。');
    }
  }

  if (subcommand === 'stop') {
    invalidateRadioGeneration(serverQueue, 'radio-stop');
    serverQueue.radio.enabled = false;
    serverQueue.radioQueue = [];
    serverQueue.radio.pendingStyle = null;
    serverQueue.radio.seedSong = null;
    serverQueue.radioFailureCount = 0;
    serverQueue.suppressRadioUntilManualPlay = false;
    savePlaybackState(interaction.guild.id, serverQueue);
    await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
    return interaction.reply('✅ 自动续播已关闭，手动队列不受影响。');
  }

  if (subcommand === 'style') {
    const nextStyle = {
      genre: resolveStyleValue(interaction, 'genre', serverQueue.radio.currentStyle.genre),
      era: resolveStyleValue(interaction, 'era', serverQueue.radio.currentStyle.era),
      language: resolveStyleValue(interaction, 'language', serverQueue.radio.currentStyle.language),
      mood: resolveStyleValue(interaction, 'mood', serverQueue.radio.currentStyle.mood),
    };

    if (
      interaction.options.getString('language') === 'any'
      && !optionWasSet(interaction, 'genre')
      && nextStyle.genre === 'cantopop'
    ) {
      nextStyle.genre = null;
    }

    if (optionWasSet(interaction, 'genre') && nextStyle.genre === 'pop' && !optionWasSet(interaction, 'language')) {
      nextStyle.language = 'english';
    }

    if (serverQueue.playing) {
      invalidateRadioGeneration(serverQueue, 'radio-style');
      serverQueue.radio.currentStyle = nextStyle;
      serverQueue.radio.pendingStyle = null;
      serverQueue.radioQueue = [];
      serverQueue.radio.enabled = true;
      serverQueue.radioFailureCount = 0;
      serverQueue.suppressRadioUntilManualPlay = false;
      if (hasExplicitStyle(nextStyle)) serverQueue.radio.seedSong = null;
      MusicPlayer.maybePrefillRadioQueue(interaction.guild.id, serverQueue, 'radio style change');
      savePlaybackState(interaction.guild.id, serverQueue);
      await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
      return interaction.reply(`✅ 已设置新风格，下一首自动续播生效：${describeStyle(nextStyle)}`);
    }

    invalidateRadioGeneration(serverQueue, 'radio-style');
    serverQueue.radio.currentStyle = nextStyle;
    serverQueue.radioQueue = [];
    if (hasExplicitStyle(nextStyle)) serverQueue.radio.seedSong = null;
    serverQueue.radio.enabled = true;
    serverQueue.radioFailureCount = 0;
    serverQueue.suppressRadioUntilManualPlay = false;
    MusicPlayer.clearIdleLeaveTimer(serverQueue);
    serverQueue.queueEnded = false;
    savePlaybackState(interaction.guild.id, serverQueue);
    await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
    return interaction.reply(`✅ 已设置自动续播风格：${describeStyle(nextStyle)}`);
  }

  if (subcommand === 'autodetect') {
    const enabled = interaction.options.getBoolean('enabled');
    serverQueue.radio.autodetect = enabled;
    savePlaybackState(interaction.guild.id, serverQueue);
    await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
    return interaction.reply(`✅ AI 自动风格识别已${enabled ? '开启' : '关闭'}。`);
  }

  if (subcommand === 'reset') {
    await interaction.deferReply();
    try {
      MusicPlayer.clearIdleLeaveTimer(serverQueue);
      serverQueue.queueEnded = false;
      invalidateRadioGeneration(serverQueue, 'radio-reset');
      serverQueue.radioQueue = [];
      serverQueue.radio.enabled = true;
      serverQueue.radioFailureCount = 0;
      serverQueue.suppressRadioUntilManualPlay = false;
      refreshRadioSeed(serverQueue);
      savePlaybackState(interaction.guild.id, serverQueue, { immediate: true });
      const generatedCount = await ensureRadioQueue(serverQueue, 5);

      if (MusicPlayer.isManualPlaybackActive(serverQueue)) {
        savePlaybackState(interaction.guild.id, serverQueue);
        await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
        return interaction.editReply(manualPlaybackRadioMessage('✅ 已重置自动续播缓存', generatedCount, serverQueue));
      }

      if (!serverQueue.playing && serverQueue.radioQueue.length > 0) {
        const voiceChannel = interaction.member.voice.channel;
        if (!serverQueue.connection) {
          if (!voiceChannel) {
            savePlaybackState(interaction.guild.id, serverQueue);
            return interaction.editReply(`✅ 已重置自动续播缓存，生成了 ${generatedCount} 首推荐。加入语音频道后使用 /radio start 开始播放。`);
          }
          serverQueue.connection = await MusicPlayer.joinVoice(
            voiceChannel,
            interaction.guild.id,
            interaction.guild.voiceAdapterCreator
          );
        }
        await MusicPlayer.playSong(interaction.guild.id, interaction.channel);
      }

      savePlaybackState(interaction.guild.id, serverQueue);
      await refreshNowPlayingPanel(interaction.guild.id, interaction.channel, serverQueue);
      if (generatedCount === 0) {
        return interaction.editReply(noRecommendationMessage(serverQueue));
      }
      return interaction.editReply(`✅ 已重置自动续播缓存，生成了 ${generatedCount} 首推荐。`);
    } catch (error) {
      console.error('[Radio] reset error:', error.message);
      return interaction.editReply('❌ 重置自动续播失败，请稍后再试。');
    }
  }

  const embed = new EmbedBuilder()
    .setColor(serverQueue.radio.enabled ? 0x00ff00 : 0x999999)
    .setTitle('📻 自动续播状态')
    .addFields(
      { name: '状态', value: serverQueue.radio.enabled ? '开启' : '关闭', inline: true },
      { name: 'AI 自动识别', value: serverQueue.radio.autodetect ? '开启' : '关闭', inline: true },
      { name: '当前风格', value: describeStyle(serverQueue.radio.currentStyle), inline: false },
      { name: '版本偏好', value: versionPreferenceLabel(serverQueue.versionPreference || 'any'), inline: false },
      { name: '待生效风格', value: serverQueue.radio.pendingStyle ? describeStyle(serverQueue.radio.pendingStyle) : '无', inline: false },
      { name: '自动续播缓存', value: `${serverQueue.radioQueue.length} 首`, inline: true },
      { name: '历史记录', value: `${serverQueue.history.length} 首`, inline: true }
    );

  return interaction.reply({ embeds: [embed] });
}
