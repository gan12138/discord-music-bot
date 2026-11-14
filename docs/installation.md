# One-Click Installation

**English** | [中文](zh-CN/installation.md)

[Back to home](../README.md) · [Configuration guide](configuration.md) · [Voice control](voice-control.md) · [Troubleshooting](troubleshooting.md)

## Supported Environments

- Ubuntu 22.04/24.04 or Debian 12/13, on amd64 or arm64.
- A server or VM with sudo/root access running systemd; ordinary Docker containers are not a supported deployment target.
- Network access to GitHub, nodejs.org, npm, PyPI and Docker registries.
- At least 2 GB of RAM is recommended, with 4 GB of free disk during installation; the default Lavalink heap cap is 512 MB.
- Local ports `2333`, `4416` and `8001` must be free. The installer exits when it finds a conflict, or a directory/service with the same name that it does not manage, rather than overwriting it.

## Running the Command

First create the music Bot in the Discord Developer Portal, invite it with the `bot` and `applications.commands` scopes, and grant View Channel, Connect, Speak, Send Messages and Embed Links permissions.

Anonymous GitHub/raw downloads of this repository return 404, so repository read access is required. The recommended path is to configure a GitHub SSH key on the server and run (this needs `git` and `python3` already installed):

```bash
work=$(mktemp -d) && git clone --depth=1 git@github.com:gan12138/discord-music-bot.git "$work/source" && sudo bash "$work/source/scripts/install.sh" --source "$work/source"
```

This fetches the code with the current user's SSH key and then installs via sudo; the GitHub key is never handed to root, and no API token has to be typed into the command. The temporary source directory can be deleted after installation.

**Only when the repository is publicly readable** does the following anonymous entry point work:

```bash
curl -fsSL https://raw.githubusercontent.com/gan12138/discord-music-bot/main/scripts/install.sh | sudo bash
```

In an authorised source directory you can check the system first:

```bash
bash scripts/install.sh --check
```

For a public repository you can also download the script and inspect it first:

```bash
curl -fsSL -o /tmp/musicbot-install.sh https://raw.githubusercontent.com/gan12138/discord-music-bot/main/scripts/install.sh
bash /tmp/musicbot-install.sh --check
sudo bash /tmp/musicbot-install.sh
```

`--check` installs no software, writes no configuration and starts no services. Use `--ref <branch-or-tag>` to pick a version, or run `sudo bash scripts/install.sh --source "$PWD"` in an existing clean source tree.

## What the Wizard Asks

1. **Bot Token**: hidden input; never placed on the command line or written to the installation log.
2. **Application ID**: validated against the Token's application so a typo is caught.
3. **Server ID**: server commands are recommended and update immediately; leaving it empty requires typing `GLOBAL` to confirm a global deployment.
4. **Cookie file paths**: separate Bilibili and YouTube Netscape files; leave both empty the first time to skip.
5. **AI**: choose not to enable it, or provide a public HTTPS address, a hidden-input key and a model name.
6. **YouTube OAuth refresh token**: hidden input when you have one; on first install you can leave it empty and complete device-code authorisation later.

When you re-run the installer, leaving Token/application ID/OAuth empty keeps the existing values, and leaving cookie paths empty keeps the existing configuration. The second voice Bot/STT can be configured after installation by following the [voice control documentation](voice-control.md).

## What the Installer Handles Automatically

- Downloads the source, using the repository's Lavalink 4.2.2 and the pinned YouTube plugin snapshot.
- Installs and SHA-256 verifies a standalone Node 22.23.3 without replacing the system Node.
- Installs the latest yt-dlp default dependency group (including the matching EJS) and `bgutil-ytdlp-pot-provider==1.3.2` into a per-version Python venv.
- Installs system Java 17+, a libopus-enabled ffmpeg and any required build tools; installs Docker if it is missing.
- Starts version-matched bgutil and yt-cipher from pinned image digests, with ports bound only to `127.0.0.1`.
- Creates the non-root `discordbot` and `lavalink` service accounts, generates a unique Lavalink password and writes it to both private configuration files.
- Verifies dependency and service-account access, checks the helper services/Lavalink, deploys the Discord commands and starts the music Bot.
- Configures boot start-up and a poToken refresh every four hours.

A successful installation means the services are ready and the Bot process started; the audio sources themselves still need a `/play` check in Discord to confirm sustained playback. YouTube cookies/OAuth do not guarantee that every video plays, and the local fallback stays available when they fail.

## File Locations

| Location | Purpose |
|----------|---------|
| `/opt/discord-music-bot` | Symlink to the current code version |
| `/opt/discord-music-bot.releases` | Per-version code and its npm/Python dependencies |
| `/opt/discord-music-bot.runtime` | Dedicated, SHA-256 verified Node |
| `/etc/discord-music-bot/bot.env` | Bot private configuration, owned by root, readable by the Bot service group, `0640` |
| `/etc/discord-music-bot/lavalink.env` | Lavalink password/OAuth, owned by root, readable by the Lavalink service group, `0640` |
| `/var/lib/discord-music-bot/data` | Playlists, server settings and PID |
| `/var/lib/discord-music-bot/cookies` | Platform cookies; directory `0700`, files `0600`, accessible only to the music Bot |
| `/var/lib/discord-music-bot-lavalink` | YAML working copy, plugins and Lavalink runtime files |
| `/var/lib/discord-music-bot-installer/backups` | Pre-switch configuration backups, root-only |

yt-dlp updates cookies, so the service account has read/write access to the cookie files; systemd only allows writes to the designated runtime directory, not to the source directory.

## Cookie Export and Update

### Exporting

1. Log in to the platform in a browser on your own computer.
2. Use a trusted export tool to export Netscape `cookies.txt` — not JSON, request headers, or `name=value;...` text.
3. Upload the file to a private directory on the server and enter its absolute path in the wizard.

The installer keeps entries for the target platform's domains (including `#HttpOnly_`) and filters out cookies for unrelated sites; it only checks the format and never displays values. Bilibili usually needs valid login fields such as `SESSDATA`. YouTube cookies are used by yt-dlp; Lavalink still needs separate OAuth.

### Updating

Re-running the install command and entering the new file paths in the wizard is recommended. You can also replace the files manually:

```bash
sudo install -o discordbot -g discordbot -m 0600 /path/to/new-bilibili.txt /var/lib/discord-music-bot/cookies/bilibili.txt
sudo install -o discordbot -g discordbot -m 0600 /path/to/new-youtube.txt /var/lib/discord-music-bot/cookies/youtube.txt
sudoedit /etc/discord-music-bot/bot.env
sudo systemctl restart discord-music-bot
```

Make sure the two settings point at the correct files, and export only the matching platform when copying manually. Cookies expire; export them again when you see a login challenge or 403 errors.

## YouTube OAuth

Without a refresh token, the installer still starts Lavalink and lets the plugin print a device-code authorisation prompt:

```bash
sudo journalctl -u discord-music-bot-lavalink --since '10 minutes ago' --no-pager
```

Complete the authorisation yourself with the pairing URL and code from the log. Once you have a refresh token, put it privately into `YOUTUBE_OAUTH_REFRESH_TOKEN` in `/etc/discord-music-bot/lavalink.env` and restart Lavalink; never paste the token into a public issue, a log screenshot or the repository.

```bash
sudoedit /etc/discord-music-bot/lavalink.env
sudo systemctl restart discord-music-bot-lavalink
```

The plugin refreshes OAuth itself; storing the refresh token in the private environment file avoids pairing again after a reinstall or a JVM restart.

## Service Management

The installer uses dedicated service names and does not overwrite a manually deployed `lavalink.service`:

```bash
sudo systemctl status discord-music-bot discord-music-bot-lavalink discord-music-bot-youtube
sudo journalctl -u discord-music-bot -u discord-music-bot-lavalink -f
sudo systemctl restart discord-music-bot
sudo systemctl status discord-music-bot-pot-refresh.timer
```

The helper containers are named `discord-music-bot-bgutil` and `discord-music-bot-cipher`. The installer never deletes or reuses identically named containers without its management label, and never modifies other existing Bots, Lavalink instances or Docker containers.

## Updates and Failure Recovery

Re-running the one-click command prepares a new version and its dependencies, and only briefly stops and switches services after the checks pass. The playlist directory is kept separately, and configuration and cookies are not wiped by an update.

If the service switch fails, the installer restores the previous version pointer, environment files, cookies, YAML, plugins and service enable/running state. Already deployed Discord commands, apt-installed packages and downloaded images are not rolled back automatically; once networking/permissions/configuration are fixed you can run it again. Install markers left behind by a first failed run identify the installer's own directories and allow resuming.

Old code and private configuration backups are not deleted automatically; if disk space runs low, an administrator can manually clean up after keeping the current version and any versions needed for rollback. Backups also contain credentials and must not be published.

## Verifying the Installer

```bash
python3 -B -m unittest discover -s test -p 'installer_test.py' -v
bash -n scripts/install.sh scripts/youtube-helpers.sh
```

For isolated dependency testing you can use `test/installer.Dockerfile`; it does not connect to real Discord, mount the host Docker socket, or start a local Bot. Dedicated Node/npm, yt-dlp/EJS, cookie load/save and generated service configuration are verified separately on Ubuntu/Debian; full account login and audio acceptance still have to be done by the deployer on the target server.
