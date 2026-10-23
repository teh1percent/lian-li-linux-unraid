#!/bin/sh
set -eu

# lianli-daemon refuses to start when it detects a generic container
# (/.dockerenv, $container, /run/.containerenv) because it cannot see host-wide
# ownership locks. On Unraid this container *is* the only owner of the
# hardware, so present it as a native install. Do not run a second copy of
# lianli-daemon on the host or in another container at the same time.
rm -f /.dockerenv /run/.containerenv /run/systemd/container 2>/dev/null || true
unset container

# Match the lianli account to Unraid's usual nobody:users (99:100) so appdata
# stays editable from shares.
if [ "$(id -g lianli)" != "$PGID" ]; then
    groupmod -o -g "$PGID" lianli
fi
if [ "$(id -u lianli)" != "$PUID" ]; then
    usermod -o -u "$PUID" -g "$PGID" lianli
fi

# What systemd-tmpfiles and the systemd unit would normally provide.
install -m 0666 -o root -g root /dev/null /run/lianli-daemon.lock
install -m 0666 -o root -g root /dev/null /run/lianli-control.lock
install -d -m 0755 -o lianli -g lianli /run/lianli
install -d -m 0750 -o lianli -g lianli /var/lib/lianli
chown -R lianli:lianli /var/lib/lianli
install -d -m 0700 -o lianli -g lianli /tmp/runtime-lianli
install -d -m 0755 -o lianli -g lianli /home/lianli
usermod -d /home/lianli lianli 2>/dev/null || true

# Device nodes must exist with lianli group access before the daemon starts.
/usr/local/bin/sync-devices.sh --once

if [ -n "${VNC_PASSWORD:-}" ]; then
    install -d -m 0700 /root/.vnc
    x11vnc -storepasswd "$VNC_PASSWORD" /root/.vnc/passwd >/dev/null
    export X11VNC_AUTH="-rfbauth /root/.vnc/passwd"
else
    export X11VNC_AUTH="-nopw"
fi

exec /usr/bin/supervisord -n -c /etc/supervisor/supervisord.conf
