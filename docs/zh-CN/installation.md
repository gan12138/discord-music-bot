# 一键安装

[English](../installation.md) | **中文**

[返回首页](../../README.zh-CN.md) · [配置指南](configuration.md) · [语音控制](voice-control.md) · [故障排查](troubleshooting.md)

## 支持环境

- Ubuntu 22.04/24.04、Debian 12/13，amd64 或 arm64。
- 有 sudo/root 权限且运行 systemd 的服务器或虚拟机；普通 Docker 容器不作为部署目标。
- 网络能访问 GitHub、nodejs.org、npm、PyPI 和 Docker 镜像源。
- 建议至少 2 GB 内存，安装期间预留 4 GB 可用磁盘；Lavalink 默认堆上限 512 MB。
- 本机 `2333`、`4416`、`8001` 未被其他服务占用。发现冲突或未受安装器管理的同名目录/服务时退出，不覆盖。

## 运行命令

先在 Discord Developer Portal 创建音乐 Bot，用 `bot`、`applications.commands` scope 邀请到服务器，授予语音查看/连接/说话和文字发送/嵌入链接权限。

当前仓库的匿名 GitHub/raw 下载返回 404，需有仓库读取权限。推荐服务器配置 GitHub SSH key 后执行（需要预先有 `git`、`python3`）：

```bash
work=$(mktemp -d) && git clone --depth=1 git@github.com:gan12138/discord-music-bot.git "$work/source" && sudo bash "$work/source/scripts/install.sh" --source "$work/source"
```

此方式用当前用户的 SSH key 获取代码，再由 sudo 安装；GitHub key 不交给 root，也不需要在命令里填写 API Token。安装完成后临时源码目录可删除。

**只有仓库开放公开读取时**，以下匿名入口才可用：

```bash
curl -fsSL https://raw.githubusercontent.com/gan12138/discord-music-bot/main/scripts/install.sh | sudo bash
```

在已授权的源码目录中可先检查系统：

```bash
bash scripts/install.sh --check
```

公开仓库也可先下载脚本查看：

```bash
curl -fsSL -o /tmp/musicbot-install.sh https://raw.githubusercontent.com/gan12138/discord-music-bot/main/scripts/install.sh
bash /tmp/musicbot-install.sh --check
sudo bash /tmp/musicbot-install.sh
```

`--check` 不安装软件、写配置或启动服务。可用 `--ref <分支或标签>` 选择版本，或在已有干净源码中执行 `sudo bash scripts/install.sh --source "$PWD"`。

## 向导内容

1. **Bot Token**：隐藏输入，不放入命令行、不输出到安装日志。
2. **应用 ID**：校验 Token 对应的应用，避免填错。
3. **服务器 ID**：推荐服务器命令，立即更新；留空需输入 `GLOBAL` 确认全局部署。
4. **Cookie 文件路径**：分别填写 Bilibili、YouTube Netscape 文件，首次留空跳过。
5. **AI**：可选择不开启，或填写公共 HTTPS 地址、隐藏输入 Key 和模型名。
6. **YouTube OAuth refresh token**：已有时隐藏输入，首次可留空并稍后完成设备码授权。

重复执行时，Token/应用 ID/OAuth 等留空沿用现有值；Cookie 路径留空保留已有配置。第二语音 Bot/STT 可在安装后按 [语音控制文档](voice-control.md) 配置。

## 安装器自动处理

- 下载源码，使用仓库中的 Lavalink 4.2.2 和固定 YouTube 插件快照。
- 安装并 SHA-256 校验独立 Node 22.23.3，不替换系统 Node。
- 在每个版本的独立 Python venv 中安装最新 yt-dlp 默认依赖组（含配套 EJS）和 `bgutil-ytdlp-pot-provider==1.3.2`。
- 安装系统 Java 17+、libopus ffmpeg 和需要的构建工具；Docker 不存在时安装。
- 使用固定镜像 digest 启动匹配版本的 bgutil 与 yt-cipher，端口只绑定 `127.0.0.1`。
- 创建非 root 的 `discordbot`、`lavalink` 服务账号，生成唯一的 Lavalink 密码，同步写入两份私有配置。
- 校验依赖和服务账号访问、检查辅助服务/Lavalink，部署 Discord 命令并启动音乐 Bot。
- 配置开机启动和每四小时 poToken 刷新。

安装成功表示服务就绪与 Bot 进程启动，音源本身还需在 Discord 用 `/play` 验证持续播放。YouTube 的 Cookie/OAuth 不保证所有视频都能播放，失败时保留本地回退。

## 文件位置

| 位置 | 用途 |
|------|------|
| `/opt/discord-music-bot` | 指向当前代码版本的符号链接 |
| `/opt/discord-music-bot.releases` | 各代码版本及其 npm/Python 依赖 |
| `/opt/discord-music-bot.runtime` | SHA-256 校验的专用 Node |
| `/etc/discord-music-bot/bot.env` | Bot 私有配置，root 所有、Bot 服务组可读，`0640` |
| `/etc/discord-music-bot/lavalink.env` | Lavalink 密码/OAuth，root 所有、Lavalink 服务组可读，`0640` |
| `/var/lib/discord-music-bot/data` | 歌单、服务器设置和 PID |
| `/var/lib/discord-music-bot/cookies` | 平台 Cookie，目录 `0700`、文件 `0600`，只供音乐 Bot 访问 |
| `/var/lib/discord-music-bot-lavalink` | YAML 工作副本、插件和 Lavalink 运行文件 |
| `/var/lib/discord-music-bot-installer/backups` | 仅 root 可访问的切换前配置备份 |

yt-dlp 会更新 Cookie，因此服务账号拥有 Cookie 文件读写权限；systemd 仅允许写入指定运行目录，不写源码目录。

## Cookie 导出与更新

### 导出

1. 在自己的电脑浏览器登录对应平台。
2. 使用可信的导出工具导出 Netscape `cookies.txt`，不是 JSON、请求头或 `name=value;...` 文本。
3. 上传文件到服务器私有目录，在向导填写绝对路径。

安装器保留目标平台域名的条目（包含 `#HttpOnly_`），过滤无关站点 Cookie；只检查格式，不展示值。Bilibili 通常需要有效 `SESSDATA` 等登录字段。YouTube Cookie 供 yt-dlp 使用，Lavalink 仍需单独 OAuth。

### 更新

推荐重新运行安装命令，在向导填写新的文件路径。也可手动替换：

```bash
sudo install -o discordbot -g discordbot -m 0600 /path/to/new-bilibili.txt /var/lib/discord-music-bot/cookies/bilibili.txt
sudo install -o discordbot -g discordbot -m 0600 /path/to/new-youtube.txt /var/lib/discord-music-bot/cookies/youtube.txt
sudoedit /etc/discord-music-bot/bot.env
sudo systemctl restart discord-music-bot
```

确认配置中的两项分别指向正确文件，手动复制时也只导出对应平台。Cookie 会过期，出现登录验证或 403 时重新导出。

## YouTube OAuth

没有 refresh token 时，安装器仍启动 Lavalink，让插件产生设备码授权提示：

```bash
sudo journalctl -u discord-music-bot-lavalink --since '10 minutes ago' --no-pager
```

按日志里的配对网址和代码本人完成授权。获得 refresh token 后，仅私下填写 `/etc/discord-music-bot/lavalink.env` 的 `YOUTUBE_OAUTH_REFRESH_TOKEN`，再重启 Lavalink；不要粘贴 Token 到公开 issue、日志截图或仓库。

```bash
sudoedit /etc/discord-music-bot/lavalink.env
sudo systemctl restart discord-music-bot-lavalink
```

插件会刷新 OAuth；将 refresh token 保存在私有环境文件可避免重新安装或 JVM 重启后再次配对。

## 服务管理

安装器使用专用服务名，不覆盖手动部署的 `lavalink.service`：

```bash
sudo systemctl status discord-music-bot discord-music-bot-lavalink discord-music-bot-youtube
sudo journalctl -u discord-music-bot -u discord-music-bot-lavalink -f
sudo systemctl restart discord-music-bot
sudo systemctl status discord-music-bot-pot-refresh.timer
```

辅助容器名为 `discord-music-bot-bgutil`、`discord-music-bot-cipher`。安装器不会删除/复用无管理标签的同名容器，不会修改已有的其他 Bot、Lavalink 或 Docker 容器。

## 更新与失败恢复

重复运行一键命令会准备新版本与依赖，成功检查后才短暂停止并切换服务。歌单目录独立保留，配置和 Cookie 不因更新而清空。

服务切换失败时恢复旧版本指针、环境文件、Cookie、YAML、插件及服务启用/运行状态。已部署的 Discord 命令、apt 安装的软件和镜像下载不自动撤销；修正网络/权限/配置后可以再次运行。首次失败留下的安装标记可识别自己的目录，支持继续安装。

旧代码与私有配置备份不会自动删除，磁盘不足时管理员可保留当前和需要回滚的版本后手动清理。备份也含凭据，不能公开。

## 安装器验证

```bash
python3 -B -m unittest discover -s test -p 'installer_test.py' -v
bash -n scripts/install.sh scripts/youtube-helpers.sh
```

隔离依赖测试可用 `test/installer.Dockerfile`，不连接真实 Discord、不挂载宿主 Docker socket、不启动本机 Bot。Ubuntu/Debian 的专用 Node/npm、yt-dlp/EJS、Cookie load/save 和生成服务配置分别验证；完整账号登录与音频验收需要部署者在目标服务器完成。
