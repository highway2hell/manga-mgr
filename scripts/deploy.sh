#!/usr/bin/env bash
# Deploy / update manga-mgr on a remote Linux box.
#
#   ./scripts/deploy.sh                       # host from scripts/deploy.local.sh
#   ./scripts/deploy.sh user@host             # or pass it directly
#   ./scripts/deploy.sh --no-restart          # sync only
#   MANGA_HOST=user@host ./scripts/deploy.sh  # or via the environment
#
# It mirrors this directory (keeping the remote cache/, data/ and config.json),
# then restarts the systemd user service if one is installed.

set -euo pipefail

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_DIR="$(cd "$SELF_DIR/.." && pwd)"
LOCAL_ENV="$SELF_DIR/deploy.local.sh"

# Local, git-ignored overrides (see scripts/deploy.local.sh.example).
if [ -f "$LOCAL_ENV" ]; then
  # shellcheck disable=SC1090
  . "$LOCAL_ENV"
fi

HOST="${MANGA_HOST:-}"
REMOTE_DIR="${REMOTE_DIR:-manga-mgr}"
SERVICE="${SERVICE:-manga-mgr}"
RESTART=1

for arg in "$@"; do
  case "$arg" in
    --no-restart) RESTART=0 ;;
    --host) shift ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) HOST="$arg" ;;
  esac
done

if [ -z "$HOST" ] || [ "$HOST" = "user@your-server" ]; then
  cat >&2 <<'USAGE'
No target host. Either pass one or create scripts/deploy.local.sh:

  cp scripts/deploy.local.sh.example scripts/deploy.local.sh
  $EDITOR scripts/deploy.local.sh      # set MANGA_HOST="you@your-server"

  ./scripts/deploy.sh you@your-server  # or just pass it here
USAGE
  exit 2
fi

echo "==> deploying $LOCAL_DIR -> $HOST:~/$REMOTE_DIR"
rsync -az --stats \
  --exclude=cache/ \
  --exclude=data/ \
  --exclude=.DS_Store \
  --exclude=config.json \
  "$LOCAL_DIR/" "$HOST:$REMOTE_DIR/" | grep -E 'Number of files transferred|Total transferred file size' || true

if [ "$RESTART" = "1" ]; then
  echo "==> restarting $SERVICE.service"
  ssh "$HOST" "systemctl --user restart $SERVICE.service && sleep 3 && systemctl --user is-active $SERVICE.service" || {
    echo "!! could not restart $SERVICE.service — start it manually:" >&2
    echo "   ssh $HOST 'cd ~/$REMOTE_DIR && ~/.local/bin/node server.js'" >&2
    exit 1
  }
  ssh "$HOST" "journalctl --user -u $SERVICE --no-pager -n 12 | tail -6"
fi

echo "==> done"
