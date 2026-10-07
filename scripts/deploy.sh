#!/usr/bin/env bash
# Deploy / update manga-mgr on a remote Linux box.
#
#   ./scripts/deploy.sh                       # uses the default host below
#   ./scripts/deploy.sh user@host             # override the host
#   ./scripts/deploy.sh user@host --no-restart
#
# It mirrors this directory (keeping the remote cache/, data/ and config.json),
# then restarts the systemd user service if one is installed.

set -euo pipefail

HOST="${1:-jacob@jacob-ubuntu-box}"
RESTART=1
for arg in "$@"; do
  [ "$arg" = "--no-restart" ] && RESTART=0
done

REMOTE_DIR="${REMOTE_DIR:-manga-mgr}"
LOCAL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE="${SERVICE:-manga-mgr}"

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
