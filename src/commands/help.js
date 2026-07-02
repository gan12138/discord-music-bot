import { SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('help')
  .setDescription('显示帮助信息');

export async function execute(interaction) {
  const commands = [
    { name: '/play <链接/关键词>', desc: '播放YouTube/Bilibili/Spotify音乐' },
    { name: '/search <关键词>', desc: '搜索YouTube视频' },
    { name: '/queue [页码]', desc: '显示播放队列' },
    { name: '/nowplaying', desc: '显示当前播放' },
    { name: '/skip', desc: '跳过当前歌曲' },
    { name: '/pause', desc: '暂停播放' },
    { name: '/resume', desc: '继续播放' },
    { name: '/stop', desc: '停止播放并清空队列' },
    { name: '/volume <0-100>', desc: '调整音量' },
    { name: '/seek <时间>', desc: '跳转到指定时间' },
    { name: '/filter <模式>', desc: '设置音频滤镜' },
    { name: '/shuffle', desc: '随机打乱队列' },
    { name: '/loop <模式>', desc: '设置循环模式' },
    { name: '/remove <位置>', desc: '移除队列中的歌曲' },
    { name: '/radio', desc: '自动续播、风格电台和AI自动识别' },
    { name: '/audio', desc: '/radio 的别名' },
    { name: '/ai-music <需求>', desc: '用自然语言让AI点歌' },
    { name: '/playlist', desc: '播放列表管理' },
    { name: '/247', desc: '24/7 语音频道保持模式' },
    { name: '/panel', desc: '显示播放控制面板' },
    { name: '/notify', desc: '设置正在播放提示方式' },
    { name: '/version', desc: '设置AI/Radio版本偏好' },
  ];

  const helpText = commands.map(cmd => `**${cmd.name}** - ${cmd.desc}`).join('\n');

  await interaction.reply({
    embeds: [{
      color: 0x0099ff,
      title: '🎵 Discord音乐Bot帮助',
      description: helpText,
      footer: { text: '支持YouTube/Bilibili/Spotify链接和AI自动续播' }
    }]
  });
}
