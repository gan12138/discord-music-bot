import { Events } from 'discord.js';
import { MusicPlayer } from '../utils/player.js';
import { safeEditReply } from '../utils/commandSafety.js';

export const name = Events.InteractionCreate;
export const once = false;

const handledInteractions = new Map();
const INTERACTION_TTL_MS = 5 * 60 * 1000;
const INTERACTION_CLEANUP_THRESHOLD = 500;

function rememberInteraction(id) {
  if (handledInteractions.has(id)) return false;

  if (handledInteractions.size > INTERACTION_CLEANUP_THRESHOLD) {
    const now = Date.now();
    for (const [key, createdAt] of handledInteractions) {
      if (now - createdAt > INTERACTION_TTL_MS) handledInteractions.delete(key);
    }
  }

  handledInteractions.set(id, Date.now());
  return true;
}

function isUnknownInteraction(error) {
  return error?.code === 10062 || String(error?.message || '').includes('Unknown interaction');
}

const PRIVATE_BY_DEFAULT_COMMANDS = new Set([
  '247',
  'ai-music',
  'audio',
  'filter',
  'loop',
  'notify',
  'panel',
  'pause',
  'play',
  'radio',
  'remove',
  'resume',
  'seek',
  'settings',
  'shuffle',
  'skip',
  'stop',
  'version',
  'volume',
  'voice-control',
  'voice-consent',
]);

function shouldDefaultPrivate(interaction) {
  if (interaction.isButton() || interaction.isStringSelectMenu()) return true;
  if (!interaction.isChatInputCommand()) return false;
  if (interaction.commandName === 'playlist') {
    const subcommand = interaction.options.getSubcommand(false);
    return !['list', 'show'].includes(subcommand);
  }
  return PRIVATE_BY_DEFAULT_COMMANDS.has(interaction.commandName);
}

function withPrivateFlag(options) {
  if (typeof options === 'string') return { content: options, flags: 64 };
  if (!options || typeof options !== 'object') return options;
  if ('flags' in options || 'ephemeral' in options) return options;
  return { ...options, flags: 64 };
}

function makeInteractionPrivateByDefault(interaction) {
  if (interaction.privateRepliesDefaulted) return;
  interaction.privateRepliesDefaulted = true;

  const reply = interaction.reply.bind(interaction);
  interaction.reply = options => reply(withPrivateFlag(options));

  const deferReply = interaction.deferReply.bind(interaction);
  interaction.deferReply = (options = {}) => deferReply(withPrivateFlag(options));

  const followUp = interaction.followUp?.bind(interaction);
  if (followUp) interaction.followUp = options => followUp(withPrivateFlag(options));
}

async function safeErrorReply(interaction, payload) {
  try {
    if (interaction.deferred) {
      await safeEditReply(interaction, payload);
    } else if (interaction.replied) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (error) {
    if (isUnknownInteraction(error)) {
      console.warn('[Interaction] response skipped because interaction is already expired/claimed');
      return;
    }
    console.error('Failed to send error response:', error.message);
  }
}

export async function execute(interaction) {
  const delay = Date.now() - interaction.createdTimestamp;
  console.log(`[Interaction] ${interaction.commandName || interaction.customId} received, delay: ${delay}ms`);

  if (!rememberInteraction(interaction.id)) {
    console.warn(`[Interaction] duplicate ignored: ${interaction.id}`);
    return;
  }

  if (interaction.guildId) {
    MusicPlayer.markActivity(interaction.guildId);
  }

  if (!interaction.isAutocomplete() && shouldDefaultPrivate(interaction)) {
    makeInteractionPrivateByDefault(interaction);
  }

  if (interaction.isAutocomplete()) {
    const command = interaction.client.commands.get(interaction.commandName);
    if (!command?.autocomplete) return;

    try {
      await command.autocomplete(interaction);
    } catch (error) {
      console.error('Error handling autocomplete:', error);
    }
  } else if (interaction.isChatInputCommand()) {
    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      console.error(`No command matching ${interaction.commandName} was found.`);
      return safeErrorReply(interaction, {
        content: '❌ 该命令还没有被当前机器人进程加载，请重启机器人后再试。',
        flags: 64,
      });
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error('Error executing command:', error);
      
      const errorMessage = {
        content: '❌ 执行命令时出现错误！',
        flags: 64
      };

      await safeErrorReply(interaction, errorMessage);
    }
  } else if (interaction.isButton()) {
    const buttonHandler = interaction.client.buttons?.get(interaction.customId.split(':')[0]);
    if (buttonHandler) {
      try {
        await buttonHandler.execute(interaction);
      } catch (error) {
        console.error('Error handling button:', error);
        await safeErrorReply(interaction, { content: '❌ 处理按钮时出现错误！', flags: 64 });
      }
    } else {
      await safeErrorReply(interaction, { content: '❌ 这个按钮已经失效，请使用最新的控制面板。', flags: 64 });
    }
  } else if (interaction.isStringSelectMenu()) {
    const selectHandler = interaction.client.selects?.get(interaction.customId.split(':')[0]);
    if (selectHandler) {
      try {
        await selectHandler.execute(interaction);
      } catch (error) {
        console.error('Error handling select menu:', error);
        await safeErrorReply(interaction, { content: '❌ 处理下拉菜单时出现错误！', flags: 64 });
      }
    } else {
      await safeErrorReply(interaction, { content: '❌ 这个下拉菜单已经失效，请重新执行命令。', flags: 64 });
    }
  }
}
