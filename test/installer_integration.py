"""Run only inside the disposable image built with test/installer.Dockerfile."""
import importlib.util
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import subprocess
import tempfile
import time
import urllib.request
import unittest

SOURCE = Path('/workspace')
spec = importlib.util.spec_from_file_location('installer_integration_module', SOURCE / 'scripts/install.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SandboxInstaller(module.Installer):
    def __init__(self, root):
        super().__init__(SOURCE, root)

    def run(self, args, **kwargs):
        if str(args[0]) == 'git' and 'rev-parse' in args:
            return subprocess.CompletedProcess(args, 0, '000000000000\n', '')
        return super().run(args, **kwargs)


class IntegrationTests(unittest.TestCase):
    def test_packages_private_runtime_and_bot_dependencies(self):
        with tempfile.TemporaryDirectory(prefix='installer-integration-') as directory:
            Path(directory).chmod(0o755)
            if os.environ.get('INSTALLER_LAVALINK_ONLY') == '1':
                SandboxInstaller(Path(directory)).create_accounts()
                self.verify_lavalink(directory)
                return
            installer = SandboxInstaller(Path(directory))
            installer.download_node()
            installer.create_accounts()
            installer.prepare_release()
            self.assertEqual(installer.run([installer.node, '--version'], capture=True).stdout.strip(), 'v' + module.NODE_VERSION)
            installed = installer.run([installer.release / '.venv/bin/python', '-c',
                                      'import importlib.metadata as m; print(m.version("bgutil-ytdlp-pot-provider")); print(m.version("yt-dlp-ejs"))'], capture=True)
            self.assertTrue(installed.stdout.startswith(module.BGUTIL_VERSION + '\n'))
            self.assertFalse((installer.release / '.env').exists())
            self.assertFalse((installer.release / 'lavalink/lavalink.env').exists())
            environment = {'PATH': f'{installer.node.parent}:{installer.release}/.venv/bin:' + module.BASE_ENV['PATH'],
                           'HOME': str(installer.data), 'MUSICBOT_DATA_PATH': str(installer.data / 'data/musicbot.json')}
            installer.run(['runuser', '-u', 'discordbot', '--', installer.node, '--input-type=module', '-e',
                           'await import("discord.js"); await import("./src/utils/player.js"); console.log("imports OK")'],
                          cwd=installer.release, env=environment)
            cookie = installer.data / 'cookies/bilibili.txt'
            installer.write_private(cookie, '# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tfixture-integration\n')
            account = pwd.getpwnam('discordbot')
            os.chown(cookie, account.pw_uid, account.pw_gid)
            installer.run(['runuser', '-u', 'discordbot', '--', installer.release / '.venv/bin/python', '-c',
                           'import sys; from yt_dlp.cookies import YoutubeDLCookieJar; jar=YoutubeDLCookieJar(sys.argv[1]); jar.load(); jar.save(); print("cookie load/save OK")', cookie], env=environment)
            self.assertEqual(cookie.stat().st_mode & 0o777, 0o600)
            private = installer.config / 'bot.env'
            installer.write_private(private, module.env_text({'AI_API_KEY': 'fixture"with\\slashes$literal', 'AI_MODEL': 'fixture model'}), 'discordbot')
            output = installer.run(['runuser', '-u', 'discordbot', '--', installer.node, '--input-type=module', '-e',
                                    'import {readFileSync} from "node:fs"; readFileSync(process.argv[1]); console.log(JSON.stringify({AI_API_KEY:process.env.AI_API_KEY}))', private],
                                   cwd=installer.release, env={**environment, **module.parse_env(private)}, capture=True)
            self.assertEqual(json.loads(output.stdout)['AI_API_KEY'], 'fixture"with\\slashes$literal')
            self.verify_lavalink(directory)
            units = Path(directory) / 'units'
            units.mkdir()
            for name, content in installer.unit_texts().items():
                (units / name).write_text(content)
            # Parser verifies generated units even without a running PID1 systemd.
            result = installer.run(['systemd-analyze', 'verify', '--man=no', *units.glob('*')], capture=True, check=False)
            errors = result.stderr
            self.assertNotIn('Unknown key', errors)
            self.assertNotIn('Invalid argument', errors)
            print('Isolated installation, Node/npm, yt-dlp/EJS, service-account imports, cookie save and unit syntax verified.')

    def verify_lavalink(self, directory):
        # Start the real bundled Lavalink in a disposable filesystem. OAuth
        # pairing and all real-account/network playback are disabled here.
        lavalink = Path(directory) / 'lavalink-test'
        lavalink.mkdir(mode=0o755)
        config = (SOURCE / 'lavalink/application.yml').read_text().replace('enabled: true\n      refreshToken:', 'enabled: false\n      refreshToken:')
        (lavalink / 'application.yml').write_text(config)
        shutil.copytree(SOURCE / 'lavalink/plugins', lavalink / 'plugins')
        account = pwd.getpwnam('lavalink')
        os.chown(lavalink, account.pw_uid, account.pw_gid)
        os.chown(lavalink / 'plugins', account.pw_uid, account.pw_gid)
        password = secrets.token_hex(32)
        with tempfile.TemporaryFile(mode='w+') as log:
            process = subprocess.Popen(['runuser', '-u', 'lavalink', '--', '/usr/bin/java', '-Xmx512m', '-jar',
                                        str(SOURCE / 'lavalink/Lavalink.jar')], cwd=lavalink,
                                       env={**module.BASE_ENV, 'LAVALINK_PASSWORD': password}, stdout=log, stderr=log)
            try:
                ready = False
                for _ in range(300):
                    if process.poll() is not None:
                        break
                    try:
                        request = urllib.request.Request('http://127.0.0.1:2333/v4/info', headers={'Authorization': password})
                        with urllib.request.urlopen(request, timeout=2) as response:
                            info = json.load(response)
                        self.assertEqual(info['version']['semver'], '4.2.2')
                        ready = True
                        break
                    except OSError:
                        time.sleep(1)
                if not ready:
                    log.seek(0)
                    output = log.read().replace(password, '[redacted]')
                    self.fail('Isolated Lavalink did not become ready:\n' + output[-6000:])
                print('Bundled Lavalink started under its service account and returned authenticated /v4/info.')
            finally:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
        self.assertTrue(ready)


if __name__ == '__main__':
    unittest.main()
