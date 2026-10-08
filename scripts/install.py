#!/usr/bin/env python3
"""Interactive installer. Importing this module never changes the host."""
import argparse
import fcntl
import getpass
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import posixpath
import pwd
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import warnings

NODE_VERSION = '22.23.3'
NODE_CHECKSUMS = {
    'x86_64': ('x64', 'df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de'),
    'aarch64': ('arm64', 'a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f'),
    'arm64': ('arm64', 'a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f'),
}
BGUTIL_VERSION = '1.3.2'
BG_IMAGE = 'brainicism/bgutil-ytdlp-pot-provider:1.3.2@sha256:9a96e6385ce1928da87dea07b1cab0413d2cf8c07a3b8a8bd419f53df2c3843c'
CIPHER_IMAGE = 'ghcr.io/kikkia/yt-cipher:master@sha256:4c5ec381ff57336cfc24822d2b526a5ad7cd0171f61065a1bbc87bb736842449'
CONTAINERS = {'discord-music-bot-bgutil': BG_IMAGE, 'discord-music-bot-cipher': CIPHER_IMAGE}
LABEL = 'io.github.gan12138.discord-music-bot'
UNITS = ['discord-music-bot.service', 'discord-music-bot-lavalink.service',
         'discord-music-bot-youtube.service', 'discord-music-bot-pot-refresh.service',
         'discord-music-bot-pot-refresh.timer']
BASE_ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
SOURCE_DIRS = {'src', 'test', 'docs', 'scripts', 'systemd', 'lavalink'}
SOURCE_FILES = {'.env.example', '.gitignore', 'package.json', 'package-lock.json',
                'README.md', 'AGENTS.md', 'CHANGELOG.md', 'LICENSE'}


class InstallError(Exception):
    pass


class Terminal:
    """Separate streams avoid Python's seek requirement for an r+ text TTY."""
    def __enter__(self):
        self.input = open('/dev/tty', 'r', encoding='utf-8')
        self.output = open('/dev/tty', 'w', encoding='utf-8', buffering=1)
        return self

    def __exit__(self, *args):
        self.input.close()
        self.output.close()

    def write(self, value):
        return self.output.write(value)

    def flush(self):
        self.output.flush()

    def readline(self):
        return self.input.readline()


def parse_env(path):
    """Parse data, never source shell syntax or expand variables."""
    if not path.exists():
        return {}
    result = {}
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        match = re.fullmatch(r'(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)', line)
        if not match:
            raise InstallError('环境文件包含无法解析的赋值，请使用 KEY=value 格式。')
        key, value = match.groups()
        value = value.strip()
        if value.startswith('"'):
            if not value.endswith('"'):
                raise InstallError('环境文件包含未闭合的引号。')
            value = re.sub(r'\\([\\"])', r'\1', value[1:-1])
        elif value.startswith("'"):
            if not value.endswith("'"):
                raise InstallError('环境文件包含未闭合的引号。')
            value = value[1:-1]
        result[key] = value
    return result


def env_text(values):
    lines = ['# Private deployment configuration. Do not commit or share this file.']
    for key, value in sorted(values.items()):
        if not re.fullmatch(r'[A-Z][A-Z0-9_]*', key):
            raise InstallError('环境变量名称无效。')
        value = str(value)
        if any(ord(char) < 32 or ord(char) == 127 for char in value):
            raise InstallError('配置值不能包含换行或控制字符。')
        escaped = value.replace('\\', '\\\\').replace('"', '\\"')
        lines.append(f'{key}="{escaped}"')
    return '\n'.join(lines) + '\n'


def validate_id(value):
    if not re.fullmatch(r'\d{16,22}', value):
        raise InstallError('请输入 16–22 位数字的 Discord ID。')
    return value


def validate_secret(value):
    if not value or value.lower().startswith(('your_', 'test-', 'replace_')):
        raise InstallError('请填写真实凭据，不能使用示例占位值。')
    if any(ord(char) < 33 or ord(char) == 127 for char in value):
        raise InstallError('凭据不能包含空白或控制字符。')
    return value


def validate_endpoint(value):
    parsed = urllib.parse.urlsplit(value)
    host = parsed.hostname or ''
    try:
        private = not ipaddress.ip_address(host).is_global
    except ValueError:
        private = host == 'localhost' or host.endswith(('.localhost', '.local'))
    if parsed.scheme != 'https' or not host or parsed.username or parsed.password or parsed.query or parsed.fragment or private:
        raise InstallError('AI 地址必须是公共 HTTPS URL，不含凭据或查询参数。')
    return value.rstrip('/')


def filter_cookie_file(source, platform):
    """Keep only this platform's Netscape entries; never log cookie data."""
    source = Path(source).expanduser()
    if not source.is_file() or source.stat().st_size > 10 * 1024 * 1024:
        raise InstallError('Cookie 文件不存在、不是普通文件或超过 10 MB。')
    domains = ('bilibili.com', 'b23.tv') if platform == 'bilibili' else ('youtube.com', 'google.com', 'googlevideo.com')
    entries = []
    for raw in source.read_text(encoding='utf-8-sig').splitlines():
        if not raw or (raw.startswith('#') and not raw.startswith('#HttpOnly_')):
            continue
        entry = raw.removeprefix('#HttpOnly_')
        fields = entry.split('\t')
        if len(fields) != 7 or fields[1] not in ('TRUE', 'FALSE') or fields[3] not in ('TRUE', 'FALSE') or not fields[4].isdigit() or not fields[2].startswith('/'):
            raise InstallError('Cookie 必须是 Netscape 格式，不能使用 JSON 或请求头格式。')
        host = fields[0].lower().lstrip('.')
        if any(host == domain or host.endswith('.' + domain) for domain in domains):
            entries.append(raw)
    if not entries:
        raise InstallError('Cookie 文件没有对应平台的记录。')
    return '# Netscape HTTP Cookie File\n# Private platform-specific export\n' + '\n'.join(entries) + '\n'


def source_files(source):
    for path in sorted(source.rglob('*')):
        relative = path.relative_to(source)
        if relative.parts[0] not in SOURCE_DIRS and relative.as_posix() not in SOURCE_FILES:
            continue
        if '__pycache__' in relative.parts or path.suffix == '.pyc':
            continue
        if path.is_symlink():
            raise InstallError('安装源码不能包含符号链接。')
        if not path.is_file():
            continue
        name = path.name.lower()
        if name != '.env.example' and (name.endswith('.env') or '.env.' in name or name.startswith('.env')) and not name.endswith('.env.example'):
            continue
        if relative.parts[0] == 'lavalink' and relative.parts[1] not in {'Lavalink.jar', 'application.yml', 'plugins', 'refresh-youtube-pot.sh', 'lavalink.env.example'}:
            continue
        if re.search(r'cookie.*\.(txt|json)|\.(log|bak|tmp|pid)$', name):
            continue
        yield path, relative


def extract_node_archive(archive, destination, prefix):
    """Validate the checksum-verified Node tar, including links, on Python 3.10+."""
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        links = {member.name.rstrip('/') for member in members if member.issym()}
        for member in members:
            name = member.name.rstrip('/')
            if name.startswith('/') or name != posixpath.normpath(name) or not (name == prefix or name.startswith(prefix + '/')):
                raise InstallError('Node 压缩包路径无效。')
            if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise InstallError('Node 压缩包包含不允许的文件类型。')
            if any(name.startswith(link + '/') for link in links):
                raise InstallError('Node 压缩包存在链接目录下的文件。')
            if member.issym() or member.islnk():
                target = member.linkname if member.islnk() else posixpath.join(posixpath.dirname(name), member.linkname)
                target = posixpath.normpath(target)
                if member.linkname.startswith('/') or not target.startswith(prefix + '/'):
                    raise InstallError('Node 压缩包包含越界链接。')
        # No member can escape the single archive root or descend through a link.
        # Python 3.10's backported data_filter mis-resolves Node's relative
        # symlinks. Our explicit validation above covers all supported versions.
        options = {'filter': 'fully_trusted'} if hasattr(tarfile, 'data_filter') else {}
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', DeprecationWarning)
            tar.extractall(destination, members=members, **options)


class Installer:
    def __init__(self, source, root=Path('/')):
        self.source = Path(source).resolve()
        self.root = Path(root)
        self.current = self.at('/opt/discord-music-bot')
        self.releases = self.at('/opt/discord-music-bot.releases')
        self.runtime = self.at('/opt/discord-music-bot.runtime')
        self.config = self.at('/etc/discord-music-bot')
        self.data = self.at('/var/lib/discord-music-bot')
        self.lavalink = self.at('/var/lib/discord-music-bot-lavalink')
        self.state = self.at('/var/lib/discord-music-bot-installer')
        self.units = self.at('/etc/systemd/system')
        self.marker = self.config / 'install.json'
        self.backups = []
        self.unit_states = {}
        self.container_states = {}
        self.switching = False
        self.old_target = None
        self.release = None
        self.bot = {}
        self.lava = {}
        self.cookies = {}
        self.tty = None
        self.lock = None
        self.had_plugins = False

    def at(self, path):
        return self.root / path.lstrip('/')

    def run(self, args, *, env=None, cwd=None, capture=False, check=True, timeout=None):
        result = subprocess.run([str(arg) for arg in args], cwd=cwd,
                                env={**BASE_ENV, **(env or {})}, text=True,
                                stdout=subprocess.PIPE if capture else None,
                                stderr=subprocess.PIPE if capture else None, timeout=timeout)
        if check and result.returncode:
            # Neither arguments nor stderr are echoed: tools may include private values.
            raise InstallError(f'{Path(str(args[0])).name} 执行失败（退出码 {result.returncode}）。')
        return result

    def http_json(self, url, headers=None, timeout=15):
        request = urllib.request.Request(url, headers={'User-Agent': 'discord-music-bot-installer', **(headers or {})})
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return json.load(response)
        except (OSError, ValueError, urllib.error.URLError):
            raise InstallError('远程服务验证失败，请检查网络、凭据和配置。') from None

    def prompt(self, message, previous='', *, secret=False, optional=False, validator=None):
        while True:
            hint = '（留空沿用）' if previous else ('（可留空）' if optional else '')
            if secret:
                value = getpass.getpass(message + hint + ': ', stream=self.tty)
            else:
                self.tty.write(message + hint + ': ')
                self.tty.flush()
                line = self.tty.readline()
                if not line:
                    raise InstallError('终端输入已结束。')
                value = line.strip()
            value = value or previous
            if not value and optional:
                return ''
            try:
                return validator(value) if validator else value
            except InstallError as error:
                self.tty.write(str(error) + '\n')

    def acquire_lock(self):
        if self.state.is_symlink():
            raise InstallError('安装状态目录不能是符号链接。')
        self.state.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(self.state, 0o700)
        self.lock = (self.state / 'install.lock').open('a')
        try:
            fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise InstallError('另一个安装器正在运行。') from None

    def preflight(self):
        if os.geteuid() != 0:
            raise InstallError('请使用 sudo 或 root 运行。')
        os_info = dict(line.split('=', 1) for line in self.at('/etc/os-release').read_text().splitlines() if '=' in line)
        pair = (os_info.get('ID', '').strip('"'), os_info.get('VERSION_ID', '').strip('"'))
        if pair not in {('ubuntu', '22.04'), ('ubuntu', '24.04'), ('debian', '12'), ('debian', '13')}:
            raise InstallError('仅支持 Ubuntu 22.04/24.04、Debian 12/13。')
        if os.uname().machine not in NODE_CHECKSUMS:
            raise InstallError('仅支持 amd64/arm64。')
        if not self.at('/run/systemd/system').is_dir():
            raise InstallError('需要正在运行 systemd 的服务器/虚拟机。')
        for directory in (self.config, self.runtime, self.releases, self.data, self.lavalink, self.state):
            if directory.is_symlink():
                raise InstallError('安装管理目录不能是符号链接。')
        managed = False
        if self.marker.exists():
            marker = json.loads(self.marker.read_text())
            managed = marker.get('installer') == 'gan12138/discord-music-bot' and marker.get('schema') == 1
            if not managed:
                raise InstallError('现有安装标记不兼容。')
        for directory in (self.data / 'data', self.data / 'cookies', self.lavalink / 'plugins'):
            if directory.is_symlink():
                raise InstallError('安装运行目录不能是符号链接。')
        if self.current.exists() or self.current.is_symlink():
            if not managed or not self.current.is_symlink() or not self.current.resolve().is_relative_to(self.releases):
                raise InstallError('/opt/discord-music-bot 已被其他安装使用，未做修改。')
            self.old_target = os.readlink(self.current)
        if not managed:
            for unit in UNITS:
                if (self.units / unit).exists():
                    raise InstallError('已有同名服务，未覆盖原有安装。')
            if any((self.config / name).exists() for name in ('bot.env', 'lavalink.env')):
                raise InstallError('已有未受安装器管理的配置，未覆盖。')
            if self.data.exists() and any(self.data.iterdir()):
                raise InstallError('已有未受安装器管理的运行数据，未覆盖。')
            if self.lavalink.exists() and any(self.lavalink.iterdir()):
                raise InstallError('已有未受安装器管理的 Lavalink 数据，未覆盖。')
        for name in ('bot.env', 'lavalink.env', 'install.json'):
            if (self.config / name).is_symlink():
                raise InstallError('私有配置不能是符号链接。')
        for name in ('discord-music-bot', 'lavalink'):
            if not managed and self.run(['systemctl', 'is-active', name + '.service'], capture=True, check=False).returncode == 0:
                raise InstallError('已有音乐 Bot/Lavalink 服务使用相同账号，请使用独立服务器部署。')
        if shutil.which('docker'):
            for name, image in CONTAINERS.items():
                result = self.run(['docker', 'inspect', name], capture=True, check=False)
                if result.returncode == 0:
                    item = json.loads(result.stdout)[0]
                    if not managed or item['Config'].get('Labels', {}).get(LABEL) != 'installer' or item['Config']['Image'] != image:
                        raise InstallError('已有同名 YouTube 容器，未做修改。')
                    expected_port = '4416' if name.endswith('bgutil') else '8001'
                    bindings = item['HostConfig'].get('PortBindings', {}).get(expected_port + '/tcp', [])
                    if bindings != [{'HostIp': '127.0.0.1', 'HostPort': expected_port}]:
                        raise InstallError('已有辅助容器不是本机端口绑定，未做修改。')
                    self.container_states[name] = item['State']['Running']
        for port, service in ((2333, 'discord-music-bot-lavalink.service'),
                              (4416, 'discord-music-bot-bgutil'), (8001, 'discord-music-bot-cipher')):
            with socket.socket() as probe:
                try:
                    probe.bind(('127.0.0.1', port))
                except OSError:
                    own = managed and (self.container_states.get(service) is True or
                        self.run(['systemctl', 'is-active', service], capture=True, check=False).returncode == 0)
                    if not own:
                        raise InstallError(f'本机端口 {port} 已被其他服务占用，未做修改。') from None
        for user in ('discordbot', 'lavalink'):
            try:
                account = pwd.getpwnam(user)
                if account.pw_uid == 0 or not account.pw_shell.endswith(('nologin', 'false')):
                    raise InstallError('同名账号不是独立服务账号，未做修改。')
            except KeyError:
                pass

    def collect_configuration(self):
        self.bot = {**parse_env(self.source / '.env.example'), **parse_env(self.config / 'bot.env')}
        self.lava = {**parse_env(self.source / 'lavalink/lavalink.env.example'), **parse_env(self.config / 'lavalink.env')}
        self.tty.write('Discord Music Bot 一键部署：Bot + Lavalink + YouTube 辅助服务\n')
        self.bot['DISCORD_TOKEN'] = self.prompt('Discord Bot Token', self.bot.get('DISCORD_TOKEN', '') if not self.bot.get('DISCORD_TOKEN', '').startswith('your_') else '', secret=True, validator=validate_secret)
        self.bot['CLIENT_ID'] = self.prompt('Discord 应用 ID', self.bot.get('CLIENT_ID', '') if not self.bot.get('CLIENT_ID', '').startswith('your_') else '', validator=validate_id)
        guild = self.prompt('服务器 ID（推荐；留空需确认全局部署）', self.bot.get('DISCORD_GUILD_ID', ''), optional=True, validator=validate_id)
        if not guild and self.prompt('输入 GLOBAL 确认更新全局命令') != 'GLOBAL':
            raise InstallError('未确认全局部署。')
        self.bot.update(DISCORD_GUILD_ID=guild, ALLOW_GLOBAL_COMMAND_DEPLOY='false' if guild else 'true')
        for platform, key in (('bilibili', 'YTDLP_BILIBILI_COOKIE_FILES'), ('youtube', 'YTDLP_YOUTUBE_COOKIE_FILES')):
            path = self.prompt(f'{platform} Cookie 文件绝对路径（留空保留已有；首次跳过）', optional=True)
            if path:
                self.cookies[platform] = filter_cookie_file(path, platform)
                self.bot[key] = f'/var/lib/discord-music-bot/cookies/{platform}.txt'
        ai = self.prompt('启用 AI 点歌？y/n', 'y' if self.bot.get('AI_ENABLED') == 'true' else 'n')
        if ai.lower() not in ('y', 'n'):
            raise InstallError('AI 选项请输入 y 或 n。')
        if ai.lower() == 'y':
            self.bot['AI_BASE_URL'] = self.prompt('AI 公共 HTTPS 地址', self.bot.get('AI_BASE_URL', ''), validator=validate_endpoint)
            self.bot['AI_API_KEY'] = self.prompt('AI API Key', self.bot.get('AI_API_KEY', ''), secret=True, validator=validate_secret)
            self.bot['AI_MODEL'] = self.prompt('AI 模型名', self.bot.get('AI_MODEL', ''))
            self.bot['AI_ENABLED'] = 'true'
        else:
            self.bot['AI_ENABLED'] = 'false'
        self.lava['YOUTUBE_OAUTH_REFRESH_TOKEN'] = self.prompt('YouTube OAuth refresh token（首次可跳过，稍后设备码授权）', self.lava.get('YOUTUBE_OAUTH_REFRESH_TOKEN', ''), secret=True, optional=True)
        password = self.lava.get('LAVALINK_PASSWORD') or self.bot.get('LAVALINK_PASSWORD')
        if not password or password == 'youshallnotpass' or password.startswith('generate_'):
            password = secrets.token_hex(32)
        self.bot.update(PLAYER_BACKEND='lavalink', LAVALINK_HOST='127.0.0.1', LAVALINK_PORT='2333',
                        LAVALINK_SECURE='false', LAVALINK_PASSWORD=password,
                        FFMPEG_BIN='/usr/bin/ffmpeg', MUSICBOT_DATA_PATH='/var/lib/discord-music-bot/data/musicbot.json')
        self.lava.update(LAVALINK_PASSWORD=password, LAVALINK_URL='http://127.0.0.1:2333',
                         YOUTUBE_POT_PROVIDER_URL='http://127.0.0.1:4416')
        env_text(self.bot)
        env_text(self.lava)
        user = self.http_json('https://discord.com/api/v10/users/@me', {'Authorization': 'Bot ' + self.bot['DISCORD_TOKEN']})
        app = self.http_json('https://discord.com/api/v10/oauth2/applications/@me', {'Authorization': 'Bot ' + self.bot['DISCORD_TOKEN']})
        if not user.get('bot') or app.get('id') != self.bot['CLIENT_ID']:
            raise InstallError('Bot Token 与应用 ID 不匹配。')

    def install_dependencies(self):
        print('安装 Java、ffmpeg 和 Python 环境…', flush=True)
        self.run(['apt-get', 'update'])
        os_info = self.at('/etc/os-release').read_text()
        java_package = 'openjdk-17-jre-headless' if 'VERSION_ID="22.04"' in os_info else 'default-jre-headless'
        packages = ['ca-certificates', 'curl', 'git', 'xz-utils', 'ffmpeg', 'python3', 'python3-venv',
                    java_package, 'util-linux', 'build-essential']
        if not shutil.which('docker'):
            packages.append('docker.io')
        self.run(['apt-get', 'install', '-y', *packages], env={'DEBIAN_FRONTEND': 'noninteractive'})
        self.run(['systemctl', 'enable', '--now', 'docker.service'])
        self.run(['docker', 'info'], capture=True)
        ffmpeg = self.run(['ffmpeg', '-version'], capture=True)
        if '--enable-libopus' not in ffmpeg.stdout + ffmpeg.stderr:
            raise InstallError('系统 ffmpeg 未启用 libopus。')
        for image in (BG_IMAGE, CIPHER_IMAGE):
            self.run(['docker', 'pull', image])

    def download_node(self):
        arch, checksum = NODE_CHECKSUMS[os.uname().machine]
        target = self.runtime / f'node-v{NODE_VERSION}-{arch}'
        if (target / 'bin/node').exists():
            self.node = target / 'bin/node'
            if self.run([self.node, '--version'], capture=True).stdout.strip() != 'v' + NODE_VERSION:
                raise InstallError('已有专用 Node 版本不匹配。')
            return
        self.runtime.mkdir(parents=True, exist_ok=True, mode=0o755)
        self.runtime.chmod(0o755)
        with tempfile.TemporaryDirectory(dir=self.runtime, prefix='.node-') as directory:
            archive = Path(directory) / 'node.tar.xz'
            url = f'https://nodejs.org/dist/v{NODE_VERSION}/node-v{NODE_VERSION}-linux-{arch}.tar.xz'
            self.run(['curl', '-fSL', '--retry', '3', '--proto', '=https', '--tlsv1.2', '-o', archive, url])
            if hashlib.sha256(archive.read_bytes()).hexdigest() != checksum:
                raise InstallError('Node 下载校验失败。')
            extract_node_archive(archive, Path(directory) / 'extracted', f'node-v{NODE_VERSION}-linux-{arch}')
            shutil.move(str(Path(directory) / 'extracted' / f'node-v{NODE_VERSION}-linux-{arch}'), target)
        for path in [target, *target.rglob('*')]:
            if not path.is_symlink():
                path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
        self.node = target / 'bin/node'

    def create_accounts(self):
        for user, home in (('discordbot', '/var/lib/discord-music-bot'), ('lavalink', '/var/lib/discord-music-bot-lavalink')):
            try:
                pwd.getpwnam(user)
            except KeyError:
                self.run(['useradd', '--system', '--user-group', '--home-dir', home, '--shell', '/usr/sbin/nologin', user])
        for path, user, mode in ((self.data, 'discordbot', 0o750), (self.data / 'data', 'discordbot', 0o700),
                                 (self.data / 'cookies', 'discordbot', 0o700), (self.lavalink, 'lavalink', 0o750)):
            path.mkdir(parents=True, exist_ok=True)
            path.chmod(mode)
            account = pwd.getpwnam(user)
            os.chown(path, account.pw_uid, account.pw_gid)
        self.config.mkdir(parents=True, exist_ok=True, mode=0o755)
        self.config.chmod(0o755)
        # Mark only this installer's directories so a failed first installation
        # can be retried without claiming any unrelated pre-existing deployment.
        if not self.marker.exists():
            self.write_private(self.marker, json.dumps({'schema': 1, 'installer': 'gan12138/discord-music-bot', 'release': None}) + '\n')

    def prepare_release(self):
        revision = self.run(['git', '-C', self.source, 'rev-parse', '--short=12', 'HEAD'], capture=True).stdout.strip()
        if not re.fullmatch(r'[a-f0-9]{12}', revision):
            raise InstallError('源码版本不可识别。')
        self.releases.mkdir(parents=True, exist_ok=True, mode=0o755)
        self.releases.chmod(0o755)
        self.release = self.releases / (revision + '-' + time.strftime('%Y%m%d%H%M%S') + '-' + secrets.token_hex(3))
        self.release.mkdir(mode=0o755)
        for original, relative in source_files(self.source):
            destination = self.release / relative
            destination.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
            shutil.copyfile(original, destination)
            destination.chmod(0o755 if original.stat().st_mode & 0o111 else 0o644)
        (self.release / 'data').symlink_to(self.data / 'data', target_is_directory=True)
        print('安装专用 yt-dlp/EJS 环境及 Bot 依赖…', flush=True)
        self.run(['python3', '-m', 'venv', self.release / '.venv'])
        self.run([self.release / '.venv/bin/python', '-m', 'pip', 'install', '--upgrade',
                  'yt-dlp[default]', 'bgutil-ytdlp-pot-provider==' + BGUTIL_VERSION])
        path = f'{self.node.parent}:{self.release}/.venv/bin:' + BASE_ENV['PATH']
        self.run([self.node.parent / 'npm', 'ci', '--omit=dev'], cwd=self.release, env={'PATH': path})
        self.run([self.node.parent / 'npm', 'run', 'check'], cwd=self.release, env={'PATH': path})
        self.run([self.release / '.venv/bin/yt-dlp', '--version'], capture=True, env={'PATH': path})
        # Public release files are readable by service accounts; private data is outside.
        for directory, _, filenames in os.walk(self.release, followlinks=False):
            Path(directory).chmod(0o755)
            for name in filenames:
                file = Path(directory) / name
                if not file.is_symlink():
                    file.chmod(file.stat().st_mode | 0o044)
        self.verify_service_access()

    def verify_service_access(self):
        path = f'{self.node.parent}:{self.release}/.venv/bin:' + BASE_ENV['PATH']
        for platform, key in (('bilibili', 'YTDLP_BILIBILI_COOKIE_FILES'), ('youtube', 'YTDLP_YOUTUBE_COOKIE_FILES')):
            if platform in self.cookies or not self.bot.get(key):
                continue
            cookie = self.bot[key].split(',')[0].strip()
            self.run(['runuser', '-u', 'discordbot', '--', '/usr/bin/test', '-r', cookie], capture=True)
            self.run(['runuser', '-u', 'discordbot', '--', '/usr/bin/test', '-w', cookie], capture=True)
        self.run(['runuser', '-u', 'discordbot', '--', self.release / '.venv/bin/yt-dlp', '--version'],
                 capture=True, env={'PATH': path, 'HOME': str(self.data)})
        java = self.run(['/usr/bin/java', '-version'], capture=True)
        version = re.search(r'version "(\d+)', java.stderr + java.stdout)
        if not version or int(version.group(1)) < 17:
            raise InstallError('Lavalink 需要 Java 17+。')

    def backup(self, path):
        if path.is_symlink():
            raise InstallError('待更新配置不能是符号链接。')
        if path.exists():
            target = self.backup_dir / str(len(self.backups))
            shutil.copy2(path, target)
            status = path.stat()
            self.backups.append((path, target, (status.st_uid, status.st_gid)))
        else:
            self.backups.append((path, None, None))

    def write_private(self, path, content, user=None):
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary = tempfile.mkstemp(dir=path.parent, prefix='.install-')
        try:
            with os.fdopen(descriptor, 'w') as handle:
                handle.write(content)
            os.chmod(temporary, 0o640 if user else 0o600)
            if user:
                account = pwd.getpwnam(user)
                os.chown(temporary, 0, account.pw_gid)
            os.replace(temporary, path)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)

    def unit_texts(self):
        node = str(self.node)
        path = f'{self.node.parent}:/opt/discord-music-bot/.venv/bin:' + BASE_ENV['PATH']
        common = ('NoNewPrivileges=yes\nPrivateTmp=yes\nPrivateDevices=yes\nProtectHome=yes\n'
                  'ProtectSystem=strict\nRestrictAddressFamilies=AF_UNIX AF_INET AF_INET6\nUMask=0077\nLimitNOFILE=4096\n')
        return {
            'discord-music-bot.service': (
                '[Unit]\nDescription=Discord Music Bot (managed installer)\nAfter=network-online.target discord-music-bot-lavalink.service\n'
                'Wants=network-online.target discord-music-bot-lavalink.service\n[Service]\nType=simple\nUser=discordbot\nGroup=discordbot\n'
                'WorkingDirectory=/opt/discord-music-bot\nEnvironmentFile=/etc/discord-music-bot/bot.env\n'
                f'Environment="PATH={path}"\nEnvironment="HOME=/var/lib/discord-music-bot"\n'
                f'ExecStart={node} /opt/discord-music-bot/src/index.js\nRestart=on-failure\nRestartSec=10\n'
                'ReadWritePaths=/var/lib/discord-music-bot\n' + common + '[Install]\nWantedBy=multi-user.target\n'),
            'discord-music-bot-lavalink.service': (
                '[Unit]\nDescription=Lavalink (managed installer)\nAfter=network-online.target discord-music-bot-youtube.service\n'
                'Wants=network-online.target discord-music-bot-youtube.service\n[Service]\nType=simple\nUser=lavalink\nGroup=lavalink\n'
                'WorkingDirectory=/var/lib/discord-music-bot-lavalink\nEnvironmentFile=/etc/discord-music-bot/lavalink.env\n'
                'Environment="LAVALINK_ENV_FILE=/etc/discord-music-bot/lavalink.env"\n'
                'ExecStart=/usr/bin/java -Xmx512m -jar /opt/discord-music-bot/lavalink/Lavalink.jar\n'
                'Restart=on-failure\nRestartSec=10\nReadWritePaths=/var/lib/discord-music-bot-lavalink\n'
                + common + '[Install]\nWantedBy=multi-user.target\n'),
            'discord-music-bot-youtube.service': (
                '[Unit]\nDescription=Local YouTube helpers (managed installer)\nRequires=docker.service\nAfter=docker.service network-online.target\n'
                '[Service]\nType=oneshot\nRemainAfterExit=yes\n'
                'ExecStart=/usr/bin/bash /opt/discord-music-bot/scripts/youtube-helpers.sh start\n'
                'ExecStop=/usr/bin/bash /opt/discord-music-bot/scripts/youtube-helpers.sh stop\n'
                'TimeoutStartSec=120\nTimeoutStopSec=30\n[Install]\nWantedBy=multi-user.target\n'),
            'discord-music-bot-pot-refresh.service': (
                '[Unit]\nDescription=Lavalink poToken refresh (managed installer)\nAfter=discord-music-bot-lavalink.service discord-music-bot-youtube.service\n'
                'Requires=discord-music-bot-lavalink.service\n[Service]\nType=oneshot\nUser=lavalink\nGroup=lavalink\n'
                'EnvironmentFile=/etc/discord-music-bot/lavalink.env\nEnvironment="LAVALINK_ENV_FILE=/etc/discord-music-bot/lavalink.env"\n'
                'ExecStart=/usr/bin/bash /opt/discord-music-bot/lavalink/refresh-youtube-pot.sh\nTimeoutStartSec=600\n'
                + common),
            'discord-music-bot-pot-refresh.timer': (
                '[Unit]\nDescription=Refresh Lavalink YouTube poToken every four hours\n[Timer]\nOnBootSec=2min\nOnUnitActiveSec=4h\n'
                'Persistent=true\nUnit=discord-music-bot-pot-refresh.service\n[Install]\nWantedBy=timers.target\n'),
        }

    def begin_transaction(self):
        self.backup_dir = self.state / 'backups' / (time.strftime('%Y%m%d%H%M%S') + '-' + secrets.token_hex(3))
        self.backup_dir.mkdir(parents=True, mode=0o700)
        for unit in UNITS:
            self.unit_states[unit] = {
                action: self.run(['systemctl', action, unit], capture=True, check=False).returncode == 0
                for action in ('is-active', 'is-enabled')
            }
        destinations = [self.config / 'bot.env', self.config / 'lavalink.env', self.marker,
                        self.lavalink / 'application.yml', *[self.units / unit for unit in UNITS],
                        *[self.data / 'cookies' / (name + '.txt') for name in self.cookies]]
        for path in destinations:
            self.backup(path)
        plugin_backup = self.backup_dir / 'plugins'
        self.had_plugins = (self.lavalink / 'plugins').exists()
        if self.had_plugins:
            shutil.copytree(self.lavalink / 'plugins', plugin_backup)
        self.switching = True

    def activate(self):
        for unit in ('discord-music-bot-pot-refresh.timer', 'discord-music-bot-pot-refresh.service',
                     'discord-music-bot.service', 'discord-music-bot-lavalink.service'):
            self.run(['systemctl', 'stop', unit], check=self.unit_states[unit]['is-active'], capture=True)
        self.write_private(self.config / 'bot.env', env_text(self.bot), 'discordbot')
        self.write_private(self.config / 'lavalink.env', env_text(self.lava), 'lavalink')
        for name, content in self.cookies.items():
            path = self.data / 'cookies' / (name + '.txt')
            self.write_private(path, content)
            account = pwd.getpwnam('discordbot')
            os.chown(path, account.pw_uid, account.pw_gid)
        shutil.copyfile(self.release / 'lavalink/application.yml', self.lavalink / 'application.yml')
        self.lavalink.joinpath('application.yml').chmod(0o644)
        plugins = self.lavalink / 'plugins'
        plugins.mkdir(exist_ok=True)
        for old in plugins.glob('youtube-plugin-*.jar'):
            old.unlink()
        for jar in (self.release / 'lavalink/plugins').glob('*.jar'):
            shutil.copyfile(jar, plugins / jar.name)
            (plugins / jar.name).chmod(0o644)
        account = pwd.getpwnam('lavalink')
        os.chown(plugins, account.pw_uid, account.pw_gid)
        for name, content in self.unit_texts().items():
            self.write_private(self.units / name, content)
            (self.units / name).chmod(0o644)
        temporary = self.current.with_name('.discord-music-bot-next')
        if temporary.exists() or temporary.is_symlink():
            temporary.unlink()
        temporary.symlink_to(self.release, target_is_directory=True)
        os.replace(temporary, self.current)
        self.run(['systemctl', 'daemon-reload'])
        self.run(['systemctl', 'enable', '--now', 'discord-music-bot-youtube.service'])
        self.wait_http('http://127.0.0.1:4416/ping', expected_version=BGUTIL_VERSION)
        self.wait_port(8001)
        self.run(['systemctl', 'enable', '--now', 'discord-music-bot-lavalink.service'])
        self.wait_http('http://127.0.0.1:2333/v4/info', headers={'Authorization': self.lava['LAVALINK_PASSWORD']}, attempts=90)
        # Deploy as the Bot account. Tokens are only in the environment, never argv.
        path = f'{self.node.parent}:{self.release}/.venv/bin:' + BASE_ENV['PATH']
        self.run(['runuser', '-u', 'discordbot', '--', self.node, self.release / 'src/deploy-commands.js'],
                 cwd=self.release, env={**self.bot, 'PATH': path, 'HOME': str(self.data)}, capture=True, timeout=120)
        self.run(['systemctl', 'reset-failed', 'discord-music-bot.service'], capture=True)
        self.run(['systemctl', 'enable', '--now', 'discord-music-bot.service', 'discord-music-bot-pot-refresh.timer'])
        time.sleep(5)
        self.run(['systemctl', 'is-active', '--quiet', 'discord-music-bot.service'])
        restarts = self.run(['systemctl', 'show', '--property=NRestarts', '--value', 'discord-music-bot.service'], capture=True).stdout.strip()
        if restarts != '0':
            raise InstallError('Bot 启动后发生重启，恢复原版本。')
        self.run(['systemctl', 'start', '--no-block', 'discord-music-bot-pot-refresh.service'])
        marker = {'schema': 1, 'installer': 'gan12138/discord-music-bot', 'release': self.release.name,
                  'node': NODE_VERSION, 'bgutil': BGUTIL_VERSION}
        self.write_private(self.marker, json.dumps(marker, indent=2) + '\n')
        self.switching = False

    def wait_http(self, url, headers=None, attempts=30, expected_version=None):
        for _ in range(attempts):
            try:
                result = self.http_json(url, headers, timeout=3)
                if expected_version and result.get('version') != expected_version:
                    raise InstallError('辅助服务版本与 yt-dlp 插件不匹配。')
                return result
            except InstallError:
                time.sleep(2)
        raise InstallError('服务就绪检查超时。')

    def wait_port(self, port):
        for _ in range(30):
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=2):
                    return
            except OSError:
                time.sleep(2)
        raise InstallError('辅助服务启动超时。')

    def rollback(self):
        if not self.switching:
            return
        print('服务切换失败，恢复原代码和私有配置…', flush=True)
        for unit in UNITS:
            self.run(['systemctl', 'stop', unit], check=False, capture=True)
        for path, saved, owner in reversed(self.backups):
            if saved is None:
                path.unlink(missing_ok=True)
            else:
                shutil.copy2(saved, path)
                os.chown(path, *owner)
        if self.old_target:
            temporary = self.current.with_name('.discord-music-bot-rollback')
            temporary.unlink(missing_ok=True)
            temporary.symlink_to(self.old_target)
            os.replace(temporary, self.current)
        elif self.current.is_symlink():
            self.current.unlink()
        if (self.backup_dir / 'plugins').exists():
            shutil.rmtree(self.lavalink / 'plugins', ignore_errors=True)
            shutil.copytree(self.backup_dir / 'plugins', self.lavalink / 'plugins')
            account = pwd.getpwnam('lavalink')
            os.chown(self.lavalink / 'plugins', account.pw_uid, account.pw_gid)
        elif not self.had_plugins:
            shutil.rmtree(self.lavalink / 'plugins', ignore_errors=True)
        for name in CONTAINERS:
            if name not in self.container_states:
                item = self.run(['docker', 'inspect', name], capture=True, check=False)
                if item.returncode == 0 and json.loads(item.stdout)[0]['Config'].get('Labels', {}).get(LABEL) == 'installer':
                    self.run(['docker', 'rm', '-f', name], capture=True, check=False)
            elif self.container_states[name]:
                self.run(['docker', 'start', name], capture=True, check=False)
            else:
                self.run(['docker', 'stop', name], capture=True, check=False)
        self.run(['systemctl', 'daemon-reload'], check=False, capture=True)
        for unit in UNITS:
            action = 'enable' if self.unit_states[unit]['is-enabled'] else 'disable'
            self.run(['systemctl', action, unit], check=False, capture=True)
        for unit in ('discord-music-bot-youtube.service', 'discord-music-bot-lavalink.service', 'discord-music-bot.service', 'discord-music-bot-pot-refresh.timer'):
            if self.unit_states[unit]['is-active']:
                self.run(['systemctl', 'start', unit], check=False, capture=True)
        self.switching = False

    def install(self):
        self.acquire_lock()
        self.preflight()
        with Terminal() as tty:
            self.tty = tty
            self.collect_configuration()
        self.install_dependencies()
        self.download_node()
        self.create_accounts()
        self.prepare_release()
        try:
            self.begin_transaction()
            self.activate()
        except BaseException:
            self.rollback()
            raise
        print('安装完成：Bot、Lavalink 和本机 YouTube 辅助服务已启动。')
        print('配置：/etc/discord-music-bot/bot.env 和 lavalink.env')
        print('Cookie：/var/lib/discord-music-bot/cookies；歌单：/var/lib/discord-music-bot/data')
        print('日志：sudo journalctl -u discord-music-bot -u discord-music-bot-lavalink -f')
        if not self.lava.get('YOUTUBE_OAUTH_REFRESH_TOKEN'):
            print('YouTube OAuth 尚待本人设备码授权：查看 Lavalink 日志完成配对，并将 refresh token 私下写入 lavalink.env。')
        print('以上为服务启动验证；请在 Discord 用 /play 验证实际持续播放。')
        print('重复运行安装命令可更新；留空沿用现有配置，歌单不会被替换。')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    args = parser.parse_args()
    try:
        Installer(args.source).install()
    except (InstallError, OSError, ValueError, EOFError, subprocess.TimeoutExpired) as error:
        message = str(error) if isinstance(error, InstallError) else '安装遇到文件、网络或数据错误；请检查服务状态后重试。'
        print(message, file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print('安装已取消。', file=sys.stderr)
        return 130
    return 0


if __name__ == '__main__':
    sys.exit(main())
