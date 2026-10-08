#!/usr/bin/env bash
set -euo pipefail

# Version/digests must match the bgutil plugin installed by install.py.
BG_IMAGE=brainicism/bgutil-ytdlp-pot-provider:1.3.2@sha256:9a96e6385ce1928da87dea07b1cab0413d2cf8c07a3b8a8bd419f53df2c3843c
CIPHER_IMAGE=ghcr.io/kikkia/yt-cipher:master@sha256:4c5ec381ff57336cfc24822d2b526a5ad7cd0171f61065a1bbc87bb736842449
LABEL=io.github.gan12138.discord-music-bot

managed_container() {
  local name=$1
  [[ "$(docker inspect --format "{{index .Config.Labels \"$LABEL\"}}" "$name")" == installer ]] || {
    printf 'Refusing to change an unmanaged container: %s\n' "$name" >&2; return 1;
  }
}

start_container() {
  local name=$1 image=$2 port=$3
  shift 3
  if docker inspect "$name" >/dev/null 2>&1; then
    managed_container "$name"
    [[ "$(docker inspect --format '{{.Config.Image}}' "$name")" == "$image" ]] || {
      printf 'Container image differs from the installer pin: %s\n' "$name" >&2; return 1;
    }
    docker start "$name" >/dev/null
  else
    docker run -d --pull=never --init --restart=unless-stopped \
      --label "$LABEL=installer" --name "$name" \
      -p "127.0.0.1:$port:$port" "$@" "$image" >/dev/null
  fi
}

case "${1:-}" in
  start)
    start_container discord-music-bot-bgutil "$BG_IMAGE" 4416
    start_container discord-music-bot-cipher "$CIPHER_IMAGE" 8001 \
      -e MAX_THREADS=1 -e OVERRIDE_PLAYER_VARIANT=IAS ;;
  stop)
    for name in discord-music-bot-bgutil discord-music-bot-cipher; do
      if docker inspect "$name" >/dev/null 2>&1; then
        managed_container "$name"
        docker stop --time=10 "$name" >/dev/null
      fi
    done ;;
  *) printf 'Usage: youtube-helpers.sh start|stop\n' >&2; exit 2 ;;
esac
