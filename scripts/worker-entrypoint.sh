#!/bin/sh

set -eu

ensure_bun_ownership() {
  path="$1"

  mkdir -p "$path"
  if [ "$(stat -c '%u' "$path")" != "$(id -u bun)" ]; then
    chown -Rh bun:bun "$path"
  fi
}

ensure_bun_ownership /home/bun/.codex
ensure_bun_ownership /home/bun/.config/gh-read
ensure_bun_ownership /home/bun/.config/gh-write
ensure_bun_ownership /var/lib/minisago
ensure_bun_ownership /workspace

mkdir -p /workspace/worktrees
chown bun:bun /workspace/worktrees
chmod 700 \
  /home/bun/.codex \
  /home/bun/.config/gh-read \
  /home/bun/.config/gh-write \
  /var/lib/minisago \
  /workspace \
  /workspace/worktrees

exec setpriv --reuid=bun --regid=bun --init-groups -- "$@"
