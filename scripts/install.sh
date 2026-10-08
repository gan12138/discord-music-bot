#!/usr/bin/env bash
set -euo pipefail

# Prompts read /dev/tty, never the pipe containing this script.
REPOSITORY=https://github.com/gan12138/discord-music-bot.git
SOURCE=''
REF=main
CHECK=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --help|-h)
      printf 'Usage: install.sh [--check] [--ref BRANCH_OR_TAG] [--source CHECKOUT]\n'
      printf 'Interactive Ubuntu/Debian installer for Bot, Lavalink and YouTube helpers.\n'
      printf 'Run --check to inspect prerequisites without changing this machine.\n'
      exit 0 ;;
    --check) CHECK=true; shift ;;
    --ref|--source)
      [[ $# -ge 2 ]] || { printf 'Missing option value\n' >&2; exit 2; }
      if [[ "$1" == --ref ]]; then REF=$2; else SOURCE=$2; fi
      shift 2 ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[[ "$REF" =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ && "$REF" != *..* ]] || {
  printf 'Invalid repository ref\n' >&2; exit 2;
}
# shellcheck disable=SC1091
source /etc/os-release
case "${ID}:${VERSION_ID}" in
  ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ;;
  *) printf 'Supported: Ubuntu 22.04/24.04, Debian 12/13.\n' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|aarch64|arm64) ;;
  *) printf 'Supported architectures: amd64 and arm64.\n' >&2; exit 1 ;;
esac
if [[ "$CHECK" == true ]]; then
  printf 'Supported OS: %s %s\nArchitecture: %s\n' "$ID" "$VERSION_ID" "$(uname -m)"
  if [[ -d /run/systemd/system ]]; then
    printf 'systemd is running.\n'
  else
    printf 'systemd is not running: use a full server/VM for installation.\n'
  fi
  printf 'Ports required: localhost 2333, 4416, 8001. No changes made.\n'
  exit 0
fi
[[ "$EUID" -eq 0 ]] || { printf 'Run with sudo or as root.\n' >&2; exit 1; }
[[ -d /run/systemd/system ]] || { printf 'A running systemd host is required.\n' >&2; exit 1; }
[[ -r /dev/tty && -w /dev/tty ]] || { printf 'An interactive terminal is required.\n' >&2; exit 1; }

if [[ -n "$SOURCE" ]]; then
  [[ -f "$SOURCE/scripts/install.py" ]] || { printf 'Installer source missing.\n' >&2; exit 1; }
  command -v python3 >/dev/null || { printf 'Install python3 before using --source.\n' >&2; exit 1; }
  exec python3 "$SOURCE/scripts/install.py" --source "$SOURCE"
fi

# Only bootstrap tools are installed here. Configuration is collected before
# installing Java, Docker and playback dependencies in the Python installer.
if ! command -v python3 >/dev/null || ! command -v git >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y python3 git ca-certificates
fi
STAGING=$(mktemp -d /tmp/discord-music-bot-bootstrap.XXXXXXXX)
trap 'rm -rf -- "$STAGING"' EXIT
if ! GIT_TERMINAL_PROMPT=0 git clone --depth=1 --single-branch --branch "$REF" "$REPOSITORY" "$STAGING/source"; then
  printf 'Repository is not anonymously accessible. Use an SSH-authorized checkout and --source.\n' >&2
  exit 1
fi
python3 "$STAGING/source/scripts/install.py" --source "$STAGING/source"
