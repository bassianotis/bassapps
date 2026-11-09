#!/bin/bash
# Ships the sign-in service to a Raspberry Pi: builds the image here (for arm64),
# sends the image over SSH, backs up on the Pi, starts the new one and waits until it's healthy.
# The one before is kept for going back.
#   tools/ship-pi.sh           ship this folder's committed code
#   tools/ship-pi.sh --back    go back to the image before
# Settings: private/install.env (start from deploy/install.env.example). It also puts the
# `bassapps` command on the Pi (bassapps reset-passphrase, as the Forgot page says).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f private/install.env ] || { echo "This installation's settings go in private/install.env: copy deploy/install.env.example there and fill it in."; exit 1; }
. private/install.env
: "${PI:?}" "${PI_DIR:?}" "${ACCOUNT_URL:?}" "${APPS:?}" "${TIME_ZONE:?}"
ON_PI=$PI_DIR
pi() { ssh -o BatchMode=yes -o ConnectTimeout=15 "$PI" "$@"; }

healthy() {
    for _ in $(seq 1 30); do
        state=$(pi "docker inspect -f '{{.State.Health.Status}}' bassapps-account 2>/dev/null" || true)
        [ "$state" = healthy ] && return 0
        sleep 3
    done
    echo "The sign-in service isn't healthy on the Pi (last: ${state:-no container}). Logs: ssh $PI docker logs --tail 50 bassapps-account"
    return 1
}

if [ "${1:-}" = --back ]; then
    pi "docker image inspect bassapps-account:previous >/dev/null && docker tag bassapps-account:previous bassapps-account:current && cd $ON_PI/account && docker compose up -d"
    healthy && echo "Back on the image before."
    exit
fi

[ -z "$(git status --porcelain)" ] || { echo "There are uncommitted changes here: commit them first, so the Pi runs a known version."; exit 1; }
rev=$(git rev-parse --short HEAD)

echo "Building $rev..."
docker build --quiet --platform linux/arm64 -t "bassapps-account:$rev" . >/dev/null
echo "Sending the image to the Pi..."
docker save "bassapps-account:$rev" | gzip -1 | pi 'gunzip | docker load' >/dev/null

echo "Backing up on the Pi, then starting $rev..."
pi "mkdir -p $ON_PI/account/data $ON_PI/backups"
pi "cat > $ON_PI/account/compose.yml" < deploy/pi/account.compose.yml
printf "ACCOUNT_URL=%s\nAPPS='%s'\nTIME_ZONE=%s\n" "$ACCOUNT_URL" "$APPS" "$TIME_ZONE" | pi "cat > $ON_PI/account/.env"
pi "cat > $ON_PI/bassapps && chmod +x $ON_PI/bassapps && sudo -n ln -sf $ON_PI/bassapps /usr/local/bin/bassapps" < deploy/pi/bassapps
pi "if docker ps --format '{{.Names}}' | grep -qx bassapps-account; then docker exec bassapps-account node service/bin/backup.ts /backups/ship-\$(date +%F-%H%M)-account; fi"
pi "if docker image inspect bassapps-account:current >/dev/null 2>&1; then docker tag bassapps-account:current bassapps-account:previous; fi; docker tag bassapps-account:$rev bassapps-account:current"
pi "cd $ON_PI/account && docker compose up -d"
healthy
pi "docker image ls bassapps-account --format '{{.Tag}}' | grep -v -x -e current -e previous -e $rev | xargs -r -I{} docker rmi bassapps-account:{} >/dev/null 2>&1 || true"
echo "Shipped $rev to the Pi."
