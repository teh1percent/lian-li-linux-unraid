# Lian Li Linux for Unraid

Docker packaging of [sgtaziz/lian-li-linux](https://github.com/sgtaziz/lian-li-linux)
for Unraid. One container runs:

- `lianli-daemon --system` as the `lianli` user, the same way upstream's
  `lianli-daemon-system.service` does. It keeps fan curves, RGB and LCDs running.
- The upstream Tauri GUI on a virtual X display, which you open in the browser
  through noVNC on port **6080**.

The image installs the upstream **Debian 13 release `.deb`** (checked against the
release's `SHA256SUMS`), so there is no Rust/Node build.

## Layout

```
Dockerfile                       debian:trixie-slim + noVNC stack + upstream .deb
rootfs/usr/local/bin/
  entrypoint.sh                  container setup that systemd/tmpfiles/udev would normally do
  sync-devices.sh                mirrors /dev/bus/usb and /dev/hidraw* from sysfs (udev stand-in)
  run-gui.sh                     launches lianli-gui and restarts it if the window is closed
rootfs/etc/supervisor/supervisord.conf
unraid/lian-li-linux.xml         Unraid Docker template
.github/workflows/docker.yml     builds and pushes to ghcr.io
```

## Publish the image

1. Create a GitHub repo named `lian-li-linux-unraid` and push this folder to it.
2. The **Build image** workflow pushes
   `ghcr.io/<you>/lian-li-linux-unraid:latest` and `:<version>`.
3. In GitHub → your profile → Packages → `lian-li-linux-unraid` → Package settings,
   set visibility to **Public** so Unraid can pull without logging in.
4. In `unraid/lian-li-linux.xml`, replace `YOUR_GITHUB_USER` with your username.

To build on the Unraid box instead (from a terminal in this folder):

```bash
docker build -t lian-li-linux-unraid:latest .
```

Then set the template's Repository to `lian-li-linux-unraid:latest`.

To follow a new upstream release, change `ARG LIANLI_VERSION` in the `Dockerfile`,
or run the workflow manually with the version as input.

## Install on Unraid

1. Copy the template onto the flash drive:

   ```bash
   cp unraid/lian-li-linux.xml /boot/config/plugins/dockerMan/templates-user/my-lian-li-linux.xml
   ```

2. **Docker → Add Container →** choose `lian-li-linux` from the Template dropdown → **Apply**.
3. Click the container icon → **WebUI**. The GUI opens in the browser.

The template defaults to:

| Setting | Container | Default |
|---|---|---|
| WebUI | `6080/tcp` | `6080` |
| AppData | `/var/lib/lianli` | `/mnt/user/appdata/lian-li-linux` |
| LCD media (read-only) | `/media/lianli` | `/mnt/user/appdata/lian-li-linux/media` |
| `VNC_PASSWORD` | | empty (no password) |
| `PUID` / `PGID` | | `99` / `100` |
| `DISPLAY_WIDTH` / `DISPLAY_HEIGHT` | | `1440` / `900` |
| `LOG_LEVEL` | | `info` |

**Privileged** is on. The daemon needs it for raw USB/HID access, and fan curves
need the host's hwmon temperature sensors under `/sys`.

## How it works around the container check

Upstream's daemon will not start if it detects a generic container. It looks for
`/.dockerenv`, `$container` or `/run/.containerenv`, then exits with *"Cannot
verify host-wide daemon ownership from this container"*. The check exists because
the daemon can't see a host-side daemon that might be driving the same hardware.
On Unraid nothing else drives that hardware, so `entrypoint.sh` removes those
markers and the daemon runs in its normal native/system mode. It still takes its
usual ownership lock, inside the container.

**So don't run two copies:** not two of these containers, and not one of these
alongside a host install.

The entrypoint also does what the distro packaging normally handles:

- creates `/run/lianli-daemon.lock` and `/run/lianli-control.lock` (tmpfiles.d)
- creates `/run/lianli` for the socket (systemd `RuntimeDirectory`)
- remaps the `lianli` user to `PUID:PGID` and owns `/var/lib/lianli` (systemd `StateDirectory`)
- starts `sync-devices.sh`. Every 3 s it recreates `/dev/bus/usb/*/*` and
  `/dev/hidraw*` from sysfs as `root:lianli 0660`, which is what upstream's
  `60-lianli.rules` grants. Without it, devices that re-enumerate after the
  container starts (LCD mode switches, replugged dongles) would be invisible.
  These nodes live in the container's private `/dev`; host permissions don't change.

## Limitations

- **Desktop mode / virtual display** (extending a desktop onto HydroShift II,
  Lancool 207 or Universal Screen LCDs) doesn't work. It needs EVDI/Hermes-KMS
  host kernel modules and a real graphical session. Cooling, RGB and LCD
  playback of images, video, templates and gauges don't need it.
- The GUI's **Settings → Configuration** service controls (enable user/system
  service, switch modes) depend on systemd and pkexec, so they will show errors
  or warnings. Ignore them: supervisord keeps the daemon running and restarts it.
  For the same reason, **Installation Health** may flag systemd/udev items.
- The GUI renders WebKit in software, so expect it to be a little slow over noVNC.
  The daemon is unaffected.
- amd64 only (upstream ships amd64 packages only).

## Troubleshooting

Container logs (Docker tab → container icon → Logs) show the daemon output.
For more detail, set `LOG_LEVEL=debug`.

Check which devices the container can see from Unraid's terminal:

```bash
docker exec lian-li-linux sh -c 'ls -l /dev/hidraw* /dev/bus/usb/*/*'
```

Upstream also ships a non-GUI diagnostic:

```bash
docker exec -u lianli lian-li-linux lianli-control diagnose-runtime
```
