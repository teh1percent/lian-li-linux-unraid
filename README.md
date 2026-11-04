# Lian Li Linux for Unraid

Docker packaging of [sgtaziz/lian-li-linux](https://github.com/sgtaziz/lian-li-linux)
for Unraid. One container runs:

- `lianli-daemon --system` as the `lianli` user, the same way upstream's
  `lianli-daemon-system.service` does. It keeps fan curves, RGB and LCDs running.
- A phone-friendly dashboard on port **6090** with every control, plus Unraid stats
  on the LCD fans, a screen designer, schedules and alerts. See
  [Dashboard and Unraid features](#dashboard-and-unraid-features).

The upstream desktop GUI is removed from the image, so there's no X display, VNC or
second port.

The image installs the upstream **Debian 13 release `.deb`** (checked against the
release's `SHA256SUMS`), so there is no Rust/Node build.

## Layout

```
Dockerfile                       debian:trixie-slim + upstream .deb
rootfs/usr/local/bin/
  entrypoint.sh                  container setup that systemd/tmpfiles/udev would normally do
  sync-devices.sh                mirrors /dev/bus/usb and /dev/hidraw* from sysfs (udev stand-in)
rootfs/opt/lianli-extras/        dashboard, Unraid stats and LCD automation (Node, no dependencies)
rootfs/etc/supervisor/supervisord.conf
tests/                           mock daemon tests and template checks: node --test tests/*.test.js
templates/lian-li-linux.xml      Unraid Docker template
ca_profile.xml, icon.*, LICENSE  Community Applications repository files
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

If the app is listed in Community Applications, open the **Apps** tab, search for
`lian-li-linux` and click **Install**. To install it by hand instead:

1. Download the template onto the flash drive, from Unraid's terminal:

   ```bash
   wget -O /boot/config/plugins/dockerMan/templates-user/my-lian-li-linux.xml https://raw.githubusercontent.com/teh1percent/lian-li-linux-unraid/main/templates/lian-li-linux.xml
   ```

   Or, from a copy of this repo on the server:

   ```bash
   cp templates/lian-li-linux.xml /boot/config/plugins/dockerMan/templates-user/my-lian-li-linux.xml
   ```

2. **Docker → Add Container →** choose `lian-li-linux` from the Template dropdown → **Apply**.
3. Click the container icon → **WebUI**. The dashboard opens in the browser.

The template defaults to:

| Setting | Container | Default |
|---|---|---|
| Dashboard (WebUI) | `6090/tcp` | `6090` |
| AppData | `/var/lib/lianli` | `/mnt/user/appdata/lian-li-linux` |
| LCD media (read-only) | `/media/lianli` | `/mnt/user/appdata/lian-li-linux/media` |
| Unraid state (read-only) | `/host/emhttp` | `/var/local/emhttp` |
| `RESET_PASSWORD` | | `no` |
| `PUID` / `PGID` | | `99` / `100` |
| OpenRGB (optional) | `6743/tcp` | not published |
| `LOG_LEVEL` | | `info` |

**Privileged** is on. The daemon needs it for raw USB/HID access, and fan curves
need the host's hwmon temperature sensors under `/sys`.

## Dashboard and Unraid features

Open `http://<server>:6090` on a phone or computer. The first visit asks you to
create a password, so do that right after installing: until then, the first person
to open the page can choose it. Only a salted hash is stored, in `extras/auth.json`
in AppData, and browsers stay signed in for 30 days. Change the password or sign out
on the **System** page.

**Forgot the password?** Edit the container, click **Show more settings**, set
**Reset dashboard password** (`RESET_PASSWORD`) to `yes` and click **Apply**. The
password is cleared once and the dashboard asks for a new one. Fan curves, lighting
and screens aren't affected. Set it back to `no` afterwards. Leaving it on `yes`
doesn't clear the new password on restart, but it has to go back to `no` before it
can reset again.

- **Status:** hottest drive, storage per pool and array, fan speeds, and parity
  state if you have a classic array. The **Storage** picker chooses whether the
  page and the Storage and Overview LCD screens show all storage or one pool.
  Charts show the last 24 hours of drive temperature, storage and fan speed.
- **Fans:** fixed speed or a fan curve, per group or on all groups, or set each fan
  separately. Groups can follow the motherboard. Curves can be created here and can
  follow the hottest drive, the average drive temperature, the hottest drive in one
  pool, or a hardware temperature sensor. **Curve smoothing** stops fans hunting
  around a curve point. Speeds stop at 20% here, so fans can't be stopped by accident.
- **AIO:** this tab appears when an AIO is connected. Set the pump and radiator fans
  to automatic, a fixed speed or a fan curve, or to follow the motherboard if the
  AIO supports it. Fixed pump speeds stop at 30%. Curves can follow coolant
  temperature on AIOs that report it. The pump screen's brightness, theme, rotation,
  colours and sensors are also here.
- **Lights:** effect, colours, brightness, speed and direction per fan group, or
  all at once. Depending on the hardware, set each zone or region separately, colour
  single LEDs, swap directions, change the LEDs per fan, or follow the motherboard.
  **Presets** and **Saved setups** store lighting under a name. **Quick Sync** runs one
  effect across several devices. The **OpenRGB server** lets OpenRGB control the
  lights; it has no password, and you publish its port in the container settings.
- **Screens:** what each LCD shows (an Unraid screen, your own design, a sensor gauge,
  your own file or a solid colour), brightness, rotation and colours. The Drives,
  Storage and Overview screens have a **Pool** choice on each LCD, so each screen can
  show a different pool, and new pools appear automatically. **System** screens show
  CPU usage, memory usage, a system overview, or any temperature sensor (chosen on
  each LCD; these gauges change colour at 70 and 85 °C). Files can be positioned and
  zoomed, and videos can set their frame rate. **Startup image** sets what a screen
  shows at power-on. **Screen designs** is a drag-and-drop designer with text, gauges,
  bars, charts, clocks, images and video. **Template catalog** installs ready-made
  designs from GitHub, and **Stored template files** clears out leftovers. **Screen
  colours** offers themes or custom colours and sets when gauges change colour. Upload
  files here, and start pixel cleaning.
- **Auto:** schedules (brightness, optional screen swap, optional lights off) and
  alerts that take over every screen for a hot drive, a disk problem, parity errors,
  a nearly full pool or hot AIO coolant. Muting lasts 24 hours. Schedules don't change fan speeds.
- **System:** pair, unpair, take over, identify, rename and restart devices. General
  settings include the USB backend and a temperature alert on the lights. **Restore a
  backup** previews and restores the daemon's own backups. Also here: Installation
  Health, a diagnostics report, an update check, a settings download, and the version
  and credits under **About**.

An LCD left on **Leave as it is** is only touched while an alert or a screen-swapping
schedule is active, and is restored afterwards.

Drive data comes from Unraid's own status files, so sleeping drives are never
woken. When every drive is asleep, the LCD screens show the hottest drive as 0.
Alerts use Unraid's per-disk status, so ZFS pool health and scrub results aren't
included.

The API only offers fixed operations with validated values. It can't set sensor
commands, because the daemon runs those as shell: curves, gauges and designs can only
use the listed sensors. Screen files must be in the media or upload folders. Five wrong passwords from one
address block sign-in for a minute. The dashboard uses plain HTTP, so the password
isn't encrypted on the network: keep it on a trusted LAN or behind a VPN or an HTTPS
reverse proxy, and don't port-forward it to the internet.

A fan group that reads **0 RPM** is reporting 0 itself, over the radio. Check that
its fans have power and are plugged into the controller.

Settings are stored in `extras/settings.json` in AppData, chart data in
`extras/history.json` and uploads in `extras/media`. The current values are
files in `/run/lianli-stats` inside the container, and they appear in the sensor
lists on the dashboard.

## Credits

Built on [Lian Li Linux](https://github.com/sgtaziz/lian-li-linux) by
[sgtaziz](https://github.com/sgtaziz), which does all the work of talking to the
hardware. It's MIT licensed, copyright 2026 sgtaziz. This repo adds the Unraid
packaging and the dashboard. Not affiliated with Lian Li Industrial Co., Ltd.

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

- **Desktop mode** (using an LCD as a monitor) isn't available. Upstream only supports
  it on the HydroShift II, Lancool 207, Universal Screen 8.8" and Vision 9.2", not on
  LCD fans, and it needs a graphical login that this container doesn't have. A screen
  left in that mode gets a **Return to LCD mode** button.
- **Service controls** from the desktop app (systemd and pkexec) aren't offered, because
  supervisord keeps the daemon running. **Installation Health** may flag systemd/udev items.
- The dashboard's upload replaces the desktop app's "import media" step.
- The image still installs the libraries the upstream package depends on, so it's
  smaller than before but not as small as it could be.
- amd64 only (upstream ships amd64 packages only).

## Support

Report problems with this package at
[this repo's issues](https://github.com/teh1percent/lian-li-linux-unraid/issues),
not on the upstream project.

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

Upstream also ships a diagnostic tool:

```bash
docker exec -u lianli lian-li-linux lianli-control diagnose-runtime
```
