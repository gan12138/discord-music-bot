import { REST, Routes } from 'discord.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readdirSync } from 'fs';
import 'dotenv/config';

for (const envName of ['DISCORD_TOKEN', 'CLIENT_ID']) {
  if (!process.env[envName]) {
    console.error(`❌ 缺少必要环境变量: ${envName}`);
    process.exit(1);
  }
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const commands = [];
const commandsPath = join(__dirname, 'commands');
const commandFiles = readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = join(commandsPath, file);
  const command = await import(`file://${filePath}`);
  if ('data' in command && 'execute' in command) {
    commands.push(command.data.toJSON());
    console.log(`✅ 已加载命令: ${command.data.name}`);
  } else {
    console.log(`⚠️  命令 ${file} 缺少必要的 "data" 或 "execute" 属性`);
  }
}

const rest = new REST().setToken(process.env.DISCORD_TOKEN);
const guildId = String(process.env.DISCORD_GUILD_ID || '').trim();
const allowGlobalDeploy = process.env.ALLOW_GLOBAL_COMMAND_DEPLOY === 'true';

if (guildId && !/^\d{16,22}$/.test(guildId)) {
  console.error('❌ DISCORD_GUILD_ID must be a valid Discord snowflake.');
  process.exitCode = 1;
} else if (!guildId && !allowGlobalDeploy) {
  console.error('❌ Global command deployment is disabled. Set DISCORD_GUILD_ID for a test guild or explicitly set ALLOW_GLOBAL_COMMAND_DEPLOY=true.');
  process.exitCode = 1;
} else {
  const route = guildId
    ? Routes.applicationGuildCommands(process.env.CLIENT_ID, guildId)
    : Routes.applicationCommands(process.env.CLIENT_ID);

  try {
    console.log(`🔄 开始刷新 ${commands.length} 个${guildId ? '服务器' : '全局'}应用命令...`);

    const data = await rest.put(route, { body: commands });

    console.log(`✅ 成功刷新 ${data.length} 个应用命令`);
  } catch (error) {
    console.error('❌ 刷新命令失败:', error?.message || 'unknown error');
    process.exitCode = 1;
  }
}
