#!/bin/sh
# Keep the GUI open: if someone closes the window in noVNC, bring it back.
export HOME=/home/lianli
export XDG_RUNTIME_DIR=/tmp/runtime-lianli
export XDG_CONFIG_HOME=/home/lianli/.config

# Wait for the X server.
i=0
while [ ! -S /tmp/.X11-unix/X0 ]; do
    i=$((i + 1)); [ "$i" -gt 50 ] && break
    sleep 0.2
done

exec dbus-run-session -- /usr/bin/lianli-gui
