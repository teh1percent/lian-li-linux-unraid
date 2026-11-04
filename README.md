# Lian Li Linux for Unraid

Docker packaging of [sgtaziz/lian-li-linux](https://github.com/sgtaziz/lian-li-linux)
for Unraid. One container runs:

- `lianli-daemon --system` as the `lianli` user, the same way upstream's
  `lianli-daemon-system.service` does. It keeps fan curves, RGB and LCDs running.
- The upstream Tauri GUI on a virtual X display, which you open in the browser
  through noVNC on port **6080**.
- A phone-friendly dashboard on port **6090**, with Unraid stats on the LCD fans,
  schedules and alerts. See [Dashboard and Unraid features](#dashboard-and-unraid-features).

The image installs the upstream **Debian 13 release `.deb`** (checked against the
release's `SHA256SUMS`), so there is no Rust/Node build.

## Layout

```
Dockerfile                       debian:trixie-slim + noVNC stack + upstream .deb
rootfs/usr/local/bin/
  entrypoint.sh                  container setup that systemd/tmpfiles/udev would normally do
  sync-devices.sh                mirrors /dev/bus/usb and /dev/hidraw* from sysfs (udev stand-in)
  run-gui.sh                     launches lianli-gui and restarts it if the window is closed
rootfs/opt/lianli-extras/        dashboard, Unraid stats and LCD automation (Node, no dependencies)
rootfs/etc/supervisor/supervisord.conf
tests/                           tests against a mock daemon: node --test tests/extras.test.js
unraid/lian-li-linux.xml         Unraid Docker template
.github/workflows/docker.yml     builds and pushes to ghcr.io
```

## Publish the image

1. Create the GitHub repo `teh1percent/lian-li-linux-unraid` and push this folder to it.
2. The **Build image** workflow pushes
   `ghcr.io/teh1percent/lian-li-linux-unraid:latest` and `:<version>`.
3. In GitHub → your profile → Packages → `lian-li-linux-unraid` → Package settings,
   set visibility to **Public** so Unraid can pull without logging in.

To build on the Unraid box instead (from a terminal in this folder):

```bash
docker build -t lian-li-linux-unraid:latest .
```

Then set the template's Repository to `lian-li-linux-unraid:latest`.

To follow a new upstream release, change `ARG LIANLI_VERSION` in the `Dockerfile`,
or run the workflow manually with the version as input.

## Install on Unraid

1. Download the template onto the flash drive, from Unraid's terminal:

   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-lian-li-linux.xml https://raw.githubusercontent.com/teh1percent/lian-li-linux-unraid/main/unraid/lian-li-linux.xml
   ```

   Or, from a copy of this repo on the server:

   ```bash
   cp unraid/lian-li-linux.xml /boot/config/plugins/dockerMan/templates-user/my-lian-li-linux.xml
   ```

2. **Docker → Add Container →** choose `lian-li-linux` from the Template dropdown → **Apply**.
3. Click the container icon → **WebUI**. The GUI opens in the browser.

The template defaults to:

| Setting | Container | Default |
|---|---|---|
| Dashboard (WebUI) | `6090/tcp` | `6090` |
| Full app | `6080/tcp` | `6080` |
| AppData | `/var/lib/lianli` | `/mnt/user/appdata/lian-li-linux` |
| LCD media (read-only) | `/media/lianli` | `/mnt/user/appdata/lian-li-linux/media` |
| Unraid state (read-only) | `/host/emhttp` | `/var/local/emhttp` |
| `WEB_PASSWORD` | | empty (no password) |
| `VNC_PASSWORD` | | empty (no password) |
| `FULL_APP_PORT` | | `6080` (host port for the dashboard's link to the full app) |
| `PUID` / `PGID` | | `99` / `100` |
| `DISPLAY_WIDTH` / `DISPLAY_HEIGHT` | | `1440` / `900` |
| `LOG_LEVEL` | | `info` |

**Privileged** is on. The daemon needs it for raw USB/HID access, and fan curves
need the host's hwmon temperature sensors under `/sys`.

## Dashboard and Unraid features

Open `http://<server>:6090` on a phone or computer.

- **Status:** hottest drive, storage per pool and array, fan speeds, and parity
  state if you have a classic array. The **Storage** picker chooses whether the
  page and the Storage and Overview LCD screens show all storage or one pool.
  Charts show the last 24 hours of drive temperature, storage and fan speed.
- **Fans:** fixed speed or a fan curve, per group or on all groups. Curves can be
  created here and can follow the hottest drive, the average drive temperature,
  the hottest drive in one pool, or a hardware temperature sensor. Speeds stop at
  20% here, so fans can't be stopped by accident.
- **Lights:** effect, colours, brightness, speed and direction per fan group, or
  all at once. **Saved setups** store a group's settings under a name.
- **Screens:** what each LCD shows (an Unraid screen, your own file or a solid
  colour), brightness, rotation and colours. Each pool has its own screen, and new
  pools get one automatically. **Screen colours** offers themes or custom colours
  and sets when gauges change colour. Upload files here, and start pixel cleaning.
- **Auto:** schedules (brightness, optional screen swap, optional lights off) and
  alerts that take over every screen for a hot drive, a disk problem, parity errors
  or a nearly full pool. Muting lasts 24 hours. Schedules don't change fan speeds.
- **System:** pair, unpair, identify and rename devices, general settings,
  Installation Health, and a settings download.

Not offered here: the template editor, AIO pages, OpenRGB, desktop mode and startup
images. They stay in the full app. The settings download is for keeping a copy;
there's no restore button.

An LCD left on **Set in the full app** is only touched while an alert or a
screen-swapping schedule is active, and is restored afterwards. An LCD given a
screen here is kept on that screen, so change it here rather than in the full app.

Drive data comes from Unraid's own status files, so sleeping drives are never
woken. When every drive is asleep, the LCD screens show the hottest drive as 0.
Alerts use Unraid's per-disk status, so ZFS pool health and scrub results aren't
included.

The API only offers fixed operations with validated values. It can't set sensor
commands, because the daemon runs those as shell: fan curves can only follow the
listed sensors. It still controls cooling and accepts file uploads, so set
`WEB_PASSWORD` unless you trust everyone on the network.

A fan group that reads **0 RPM** is reporting 0 itself, over the radio. Check that
its fans have power and are plugged into the controller.

Settings are stored in `extras/settings.json` in AppData, chart data in
`extras/history.json` and uploads in `extras/media`. The current values are
files in `/run/lianli-stats` inside the container. You can use them in your own
templates and fan curves, for example with the sensor command
`cat /run/lianli-stats/disk_temp_max`.

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

Check the Unraid values the dashboard and LCD screens use:

```bash
docker exec lian-li-linux sh -c 'grep . /run/lianli-stats/*'
```

Upstream also ships a non-GUI diagnostic:

```bash
docker exec -u lianli lian-li-linux lianli-control diagnose-runtime
```
