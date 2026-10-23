#!/bin/sh
# Stand-in for udev inside the container.
#
# A privileged container gets a snapshot of /dev at start, so devices that
# re-enumerate later (LCD mode switches, dongles replugged) would be missing.
# Mirror the host's USB and hidraw nodes from sysfs and apply the same access
# that upstream's 60-lianli.rules grants: group lianli, mode 0660.
#
# Usage: sync-devices.sh [--once]

sync_once() {
    # libusb nodes: /dev/bus/usb/BBB/DDD
    seen=" "
    for dev in /sys/bus/usb/devices/*; do
        [ -r "$dev/dev" ] && [ -r "$dev/busnum" ] && [ -r "$dev/devnum" ] || continue
        bus=$(printf '%03d' "$(cat "$dev/busnum")")
        num=$(printf '%03d' "$(cat "$dev/devnum")")
        node="/dev/bus/usb/$bus/$num"
        seen="$seen$node "
        majmin=$(cat "$dev/dev")
        if [ ! -c "$node" ] || [ "$(stat -c '%t:%T' "$node" 2>/dev/null)" != "$(hex "$majmin")" ]; then
            mkdir -p "/dev/bus/usb/$bus"
            rm -f "$node"
            mknod -m 0660 "$node" c "${majmin%%:*}" "${majmin##*:}" || continue
        fi
        fix "$node"
    done
    # Drop nodes for devices that have gone away so libusb does not open a
    # stale node that now belongs to a different device. Skip this if sysfs
    # showed nothing, rather than wiping every node.
    [ "$seen" = " " ] && return
    for node in /dev/bus/usb/*/*; do
        [ -c "$node" ] || continue
        case "$seen" in *" $node "*) ;; *) rm -f "$node" ;; esac
    done

    # hidapi nodes: /dev/hidrawN
    for dev in /sys/class/hidraw/hidraw*; do
        [ -r "$dev/dev" ] || continue
        node="/dev/$(basename "$dev")"
        majmin=$(cat "$dev/dev")
        if [ ! -c "$node" ] || [ "$(stat -c '%t:%T' "$node" 2>/dev/null)" != "$(hex "$majmin")" ]; then
            rm -f "$node"
            mknod -m 0660 "$node" c "${majmin%%:*}" "${majmin##*:}" || continue
        fi
        fix "$node"
    done
    for node in /dev/hidraw*; do
        [ -c "$node" ] || continue
        [ -e "/sys/class/hidraw/$(basename "$node")" ] || rm -f "$node"
    done
}

# stat prints major/minor in hex
hex() { printf '%x:%x' "${1%%:*}" "${1##*:}"; }

fix() {
    [ "$(stat -c '%G:%a' "$1")" = "lianli:660" ] && return
    chgrp lianli "$1" && chmod 0660 "$1"
}

if [ "${1:-}" = "--once" ]; then
    sync_once
    exit 0
fi

while :; do
    sync_once
    sleep 3
done
