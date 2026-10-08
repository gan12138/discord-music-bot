"""No network, package installation, login, Docker or real service changes."""
import importlib.util
import io
import json
import os
from pathlib import Path
import pty
import pwd
import select
import signal
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('musicbot_installer', ROOT / 'scripts/install.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FakeInstaller(module.Installer):
    def __init__(self, source, root):
        super().__init__(source, root)
        self.calls = []
        self.active = set()
        self.enabled = set()
        self.fail_deploy = False
        self.node = self.runtime / 'node/bin/node'

    def run(self, args, **options):
        args = list(map(str, args))
        self.calls.append((args, options))
        code = 0
        output = ''
        if args[0] == 'systemctl':
            action = args[1]
            units = [name for name in args[2:] if name.endswith(('.service', '.timer'))]
            if action == 'is-active':
                code = 0 if units[0] in self.active else 3
            elif action == 'is-enabled':
                code = 0 if units[0] in self.enabled else 1
            elif action == 'stop':
                self.active.difference_update(units)
            elif action == 'start':
                self.active.update(units)
            elif action == 'enable':
                self.enabled.update(units)
                if '--now' in args:
                    self.active.update(units)
            elif action == 'disable':
                self.enabled.difference_update(units)
            elif action == 'show':
                output = '0\n'
        elif args[0] == 'docker' and args[1] == 'inspect':
            code = 1
        elif args[0] == 'runuser' and self.fail_deploy:
            raise module.InstallError('Simulated deploy failure')
        return subprocess.CompletedProcess(args, code, output, '')

    def wait_http(self, *args, **kwargs):
        return {'version': module.BGUTIL_VERSION}

    def wait_port(self, *args):
        return None


class InstallerTests(unittest.TestCase):
    def test_helper_lifecycle_binds_only_localhost_and_rejects_unmanaged_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state = root / 'state.json'
            calls = root / 'calls.json'
            state.write_text('{}')
            calls.write_text('[]')
            docker = root / 'docker'
            docker.write_text('#!' + sys.executable + '\n' + '''
import json, os, sys
from pathlib import Path
state_path=Path(os.environ['STATE']); calls_path=Path(os.environ['CALLS'])
state=json.loads(state_path.read_text()); calls=json.loads(calls_path.read_text())
args=sys.argv[1:]; calls.append(args); calls_path.write_text(json.dumps(calls))
if args[0]=='inspect':
 name=args[-1]
 if name not in state: sys.exit(1)
 if '--format' in args:
  print(state[name]['image'] if '.Config.Image' in args[2] else state[name]['label'])
elif args[0]=='run':
 name=args[args.index('--name')+1]; image=args[-1]
 state[name]={'image':image,'label':'installer','running':True}
elif args[0]=='start': state[args[1]]['running']=True
elif args[0]=='stop': state[args[-1]]['running']=False
state_path.write_text(json.dumps(state))
''')
            docker.chmod(0o755)
            environment = {**os.environ, 'PATH': str(root) + ':' + os.environ['PATH'], 'STATE': str(state), 'CALLS': str(calls)}
            script = ROOT / 'scripts/youtube-helpers.sh'
            subprocess.run(['bash', script, 'start'], env=environment, check=True, capture_output=True)
            initial = json.loads(state.read_text())
            self.assertEqual(set(initial), set(module.CONTAINERS))
            for command in json.loads(calls.read_text()):
                if command[0] == 'run':
                    binding = command[command.index('-p') + 1]
                    self.assertTrue(binding.startswith('127.0.0.1:'))
            subprocess.run(['bash', script, 'start'], env=environment, check=True, capture_output=True)
            subprocess.run(['bash', script, 'stop'], env=environment, check=True, capture_output=True)
            self.assertTrue(all(not item['running'] for item in json.loads(state.read_text()).values()))
            existing = json.loads(state.read_text())
            existing['discord-music-bot-bgutil']['label'] = 'someone-else'
            state.write_text(json.dumps(existing))
            before = len(json.loads(calls.read_text()))
            result = subprocess.run(['bash', script, 'start'], env=environment, capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            subsequent = json.loads(calls.read_text())[before:]
            self.assertFalse(any(command[0] in ('run', 'start', 'stop', 'rm') for command in subsequent))

    def test_preflight_refuses_unmanaged_directory_and_occupied_ports(self):
        with tempfile.TemporaryDirectory() as directory:
            installer = FakeInstaller(ROOT, Path(directory))
            installer.at('/etc').mkdir()
            installer.at('/etc/os-release').write_text('ID=debian\nVERSION_ID="12"\n')
            installer.at('/run/systemd/system').mkdir(parents=True)
            installer.current.mkdir(parents=True)
            with patch.object(module.os, 'geteuid', return_value=0):
                with self.assertRaisesRegex(module.InstallError, '其他安装'):
                    installer.preflight()
            installer.current.rmdir()
            fake_socket = unittest.mock.MagicMock()
            fake_socket.bind.side_effect = OSError('port occupied')
            with patch.object(module.os, 'geteuid', return_value=0), patch.object(module.shutil, 'which', return_value=None), \
                 patch.object(module.socket, 'socket') as create_socket:
                create_socket.return_value.__enter__.return_value = fake_socket
                with self.assertRaisesRegex(module.InstallError, '2333'):
                    installer.preflight()
            self.assertTrue(all(args[1] == 'is-active' for args, _ in installer.calls))

    def test_pipe_mode_uses_tty_and_never_echoes_the_hidden_token(self):
        # An actual controlling PTY, while stdin is a pipe as with curl | bash.
        process, descriptor = pty.fork()
        if process == 0:
            input_fd, output_fd = os.pipe()
            os.close(output_fd)
            os.dup2(input_fd, 0)
            os.execv(sys.executable, [sys.executable, '-B', '-c',
                'import importlib.util; from pathlib import Path; '
                f's=importlib.util.spec_from_file_location("i",{str(ROOT / "scripts/install.py")!r}); '
                'm=importlib.util.module_from_spec(s); s.loader.exec_module(m); i=m.Installer(Path(".")); '
                'tty=m.Terminal().__enter__(); i.tty=tty; '
                'secret=i.prompt("TOKEN",secret=True,validator=m.validate_secret); '
                'app=i.prompt("APP",validator=m.validate_id); print("TTY_OK",len(secret),len(app))'])
        received = b''
        try:
            for expected, answer in [(b'TOKEN', b'fixture-hidden-value\n'), (b'APP', b'123456789012345678\n'), (b'TTY_OK', None)]:
                for _ in range(100):
                    ready, _, _ = select.select([descriptor], [], [], 0.1)
                    if ready:
                        try:
                            received += os.read(descriptor, 4096)
                        except OSError:
                            break
                    if expected in received:
                        break
                self.assertIn(expected, received)
                if answer:
                    os.write(descriptor, answer)
            _, status = os.waitpid(process, 0)
            self.assertEqual(os.waitstatus_to_exitcode(status), 0)
            self.assertNotIn(b'fixture-hidden-value', received)
        finally:
            os.close(descriptor)
            try:
                os.kill(process, signal.SIGKILL)
                os.waitpid(process, 0)
            except ProcessLookupError:
                pass

    def test_tar_rejects_traversal_and_links_outside_the_node_root(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'archive.tar'
            for name, link in [('node/../../escape', ''), ('node/bin/npm', '../../../escape')]:
                with tarfile.open(path, 'w') as archive:
                    member = tarfile.TarInfo(name)
                    if link:
                        member.type = tarfile.SYMTYPE
                        member.linkname = link
                    archive.addfile(member)
                with self.assertRaises(module.InstallError):
                    module.extract_node_archive(path, Path(directory) / 'output', 'node')

    def test_environment_round_trip_never_expands_shell(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'config'
            values = {'AI_API_KEY': 'key"with\\slashes$and`literal`', 'AI_MODEL': 'model # one', 'CLIENT_ID': '123456789012345678'}
            path.write_text(module.env_text(values))
            self.assertEqual(module.parse_env(path), values)
            self.assertFalse((Path(directory) / 'literal').exists())
        with self.assertRaises(module.InstallError):
            module.env_text({'API_KEY': 'bad\nOTHER=injected'})

    def test_cookie_filter_keeps_platform_and_httponly_without_output(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'export'
            path.write_text('# Netscape HTTP Cookie File\n'
                            '#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tfixture-bili\n'
                            '.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tfixture-youtube\n'
                            '.unrelated.example\tTRUE\t/\tTRUE\t0\tSID\tfixture-unrelated\n')
            bili = module.filter_cookie_file(path, 'bilibili')
            youtube = module.filter_cookie_file(path, 'youtube')
            self.assertIn('#HttpOnly_.bilibili.com', bili)
            self.assertNotIn('fixture-youtube', bili)
            self.assertNotIn('fixture-bili', youtube)
            self.assertNotIn('fixture-unrelated', bili + youtube)
            path.write_text('{"cookie":"not-netscape"}')
            with self.assertRaises(module.InstallError):
                module.filter_cookie_file(path, 'youtube')

    def test_source_selection_does_not_copy_private_files_or_dependencies(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['.env', '.env.example', 'lavalink/lavalink.env', 'lavalink/lavalink.env.example',
                         'lavalink/Lavalink.jar', 'lavalink/cookies.txt', 'lavalink/application.yml',
                         'scripts/install.py', 'scripts/__pycache__/install.pyc',
                         'node_modules/fake/index.js', 'data/musicbot.json', 'src/index.js']:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture')
            copied = {relative.as_posix() for _, relative in module.source_files(root)}
            self.assertEqual(copied, {'.env.example', 'lavalink/lavalink.env.example', 'lavalink/Lavalink.jar',
                                      'lavalink/application.yml', 'scripts/install.py', 'src/index.js'})

    def fixture(self, directory):
        root = Path(directory)
        installer = FakeInstaller(ROOT, root)
        installer.config.mkdir(parents=True)
        installer.units.mkdir(parents=True)
        installer.data.joinpath('cookies').mkdir(parents=True)
        installer.data.joinpath('data').mkdir()
        installer.lavalink.joinpath('plugins').mkdir(parents=True)
        installer.state.mkdir(parents=True)
        installer.releases.mkdir(parents=True)
        old = installer.releases / 'old'
        old.mkdir()
        installer.current.symlink_to(old)
        installer.old_target = str(old)
        installer.release = installer.releases / 'new'
        installer.release.joinpath('lavalink/plugins').mkdir(parents=True)
        installer.release.joinpath('lavalink/application.yml').write_text('new yaml')
        installer.release.joinpath('lavalink/plugins/youtube-plugin-new.jar').write_text('new plugin')
        installer.lavalink.joinpath('application.yml').write_text('old yaml')
        installer.lavalink.joinpath('plugins/youtube-plugin-old.jar').write_text('old plugin')
        installer.bot = {'DISCORD_TOKEN': 'fixture-token', 'CLIENT_ID': '123456789012345678'}
        installer.lava = {'LAVALINK_PASSWORD': 'fixture-password'}
        (installer.config / 'bot.env').write_text(module.env_text({'DISCORD_TOKEN': 'old-fixture-token'}))
        (installer.config / 'bot.env').chmod(0o640)
        (installer.config / 'lavalink.env').write_text(module.env_text({'LAVALINK_PASSWORD': 'old-fixture-password'}))
        (installer.data / 'data/musicbot.json').write_text('{"playlists":["keep-me"]}')
        for name in module.UNITS:
            (installer.units / name).write_text('old unit ' + name)
        installer.active.update({'discord-music-bot.service', 'discord-music-bot-lavalink.service'})
        installer.enabled.update(installer.active)
        return installer

    def test_switch_is_atomic_preserves_data_and_passes_secret_only_in_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            installer = self.fixture(directory)
            installer.cookies = {'bilibili': '# Netscape HTTP Cookie File\n'}
            with patch.object(module.pwd, 'getpwnam', return_value=pwd.getpwuid(os.getuid())), patch.object(module.time, 'sleep'):
                installer.begin_transaction()
                installer.activate()
            self.assertEqual(installer.current.resolve(), installer.release)
            self.assertIn('keep-me', (installer.data / 'data/musicbot.json').read_text())
            self.assertEqual((installer.config / 'bot.env').stat().st_mode & 0o777, 0o640)
            self.assertEqual((installer.data / 'cookies/bilibili.txt').stat().st_mode & 0o777, 0o600)
            deploy = next((args, options) for args, options in installer.calls if args[0] == 'runuser')
            self.assertNotIn('fixture-token', ' '.join(deploy[0]))
            self.assertEqual(deploy[1]['env']['DISCORD_TOKEN'], 'fixture-token')
            self.assertFalse(installer.switching)

    def test_failed_switch_restores_code_config_plugins_units_and_service_state(self):
        with tempfile.TemporaryDirectory() as directory:
            installer = self.fixture(directory)
            installer.fail_deploy = True
            with patch.object(module.pwd, 'getpwnam', return_value=pwd.getpwuid(os.getuid())), patch.object(module.time, 'sleep'):
                installer.begin_transaction()
                with self.assertRaises(module.InstallError):
                    installer.activate()
                installer.rollback()
            self.assertEqual(installer.current.resolve(), installer.releases / 'old')
            self.assertEqual(module.parse_env(installer.config / 'bot.env')['DISCORD_TOKEN'], 'old-fixture-token')
            self.assertEqual((installer.config / 'bot.env').stat().st_mode & 0o777, 0o640)
            self.assertTrue((installer.lavalink / 'plugins/youtube-plugin-old.jar').exists())
            self.assertFalse((installer.lavalink / 'plugins/youtube-plugin-new.jar').exists())
            self.assertEqual(installer.active, {'discord-music-bot.service', 'discord-music-bot-lavalink.service'})
            self.assertIn('keep-me', (installer.data / 'data/musicbot.json').read_text())

    def test_first_install_failure_keeps_its_marker_and_can_retry_without_data_loss(self):
        with tempfile.TemporaryDirectory() as directory:
            installer = self.fixture(directory)
            installer.current.unlink()
            installer.old_target = None
            installer.active.clear()
            installer.enabled.clear()
            for name in module.UNITS:
                (installer.units / name).unlink()
            for name in ('bot.env', 'lavalink.env'):
                (installer.config / name).unlink()
            installer.marker.write_text('{"schema":1,"installer":"gan12138/discord-music-bot","release":null}')
            installer.fail_deploy = True
            with patch.object(module.pwd, 'getpwnam', return_value=pwd.getpwuid(os.getuid())), patch.object(module.time, 'sleep'):
                installer.begin_transaction()
                with self.assertRaises(module.InstallError):
                    installer.activate()
                installer.rollback()
                self.assertFalse(installer.current.is_symlink())
                self.assertTrue(installer.marker.exists())
                self.assertFalse((installer.config / 'bot.env').exists())
                installer.backups = []
                installer.fail_deploy = False
                installer.begin_transaction()
                installer.activate()
            self.assertEqual(installer.current.resolve(), installer.release)
            self.assertIn('keep-me', (installer.data / 'data/musicbot.json').read_text())

    def test_rerun_keeps_existing_credentials_cookie_paths_and_optional_features(self):
        with tempfile.TemporaryDirectory() as directory:
            installer = self.fixture(directory)
            old = {'DISCORD_TOKEN': 'existing-fixture-token', 'CLIENT_ID': '123456789012345678',
                   'DISCORD_GUILD_ID': '234567890123456789', 'AI_ENABLED': 'false',
                   'YTDLP_YOUTUBE_COOKIE_FILES': '/var/lib/discord-music-bot/cookies/youtube.txt',
                   'VOICE_LISTENER_ENABLED': 'true', 'VOICE_LISTENER_TOKEN': 'existing-listener-fixture'}
            (installer.config / 'bot.env').write_text(module.env_text(old))
            installer.tty = io.StringIO()
            installer.prompt = lambda message, previous='', **kwargs: previous
            installer.http_json = lambda url, *args, **kwargs: {'bot': True} if 'users' in url else {'id': old['CLIENT_ID']}
            installer.collect_configuration()
            for key in old:
                self.assertEqual(installer.bot[key], old[key])
            self.assertEqual(installer.bot['LAVALINK_PASSWORD'], 'old-fixture-password')

    def test_units_keep_cookies_writable_and_helpers_local(self):
        installer = FakeInstaller(ROOT, Path('/'))
        units = installer.unit_texts()
        self.assertEqual(set(units), set(module.UNITS))
        self.assertIn('ReadWritePaths=/var/lib/discord-music-bot\n', units['discord-music-bot.service'])
        self.assertIn('/opt/discord-music-bot/.venv/bin', units['discord-music-bot.service'])
        self.assertNotIn('ExecStartPost', units['discord-music-bot-lavalink.service'])
        script = (ROOT / 'scripts/youtube-helpers.sh').read_text()
        self.assertIn('127.0.0.1:$port:$port', script)
        self.assertIn(module.BG_IMAGE, script)
        self.assertIn(module.CIPHER_IMAGE, script)


if __name__ == '__main__':
    unittest.main()
