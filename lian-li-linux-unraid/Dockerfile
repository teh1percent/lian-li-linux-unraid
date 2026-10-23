# Lian Li Linux (https://github.com/sgtaziz/lian-li-linux) packaged for Unraid.
#
# Runs the hardware daemon in system mode plus the Tauri GUI inside a virtual
# X display, exposed in the browser through noVNC.

FROM debian:trixie-slim

ARG LIANLI_VERSION=1.2.3
ARG DEBIAN_FRONTEND=noninteractive

# Desktop-in-a-browser stack: Xvfb -> openbox -> x11vnc -> websockify/noVNC.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      xvfb x11vnc openbox novnc python3-websockify \
      dbus dbus-x11 supervisor procps tzdata \
      fonts-dejavu-core fonts-noto-color-emoji \
      libgl1-mesa-dri \
 && rm -rf /var/lib/apt/lists/*

# Install the upstream Debian 13 release package, verified against SHA256SUMS.
# Its postinst creates the `lianli` system user and the shared lock files.
RUN set -eux; \
    deb="lian-li-linux_${LIANLI_VERSION}+debian13_amd64.deb"; \
    base="https://github.com/sgtaziz/lian-li-linux/releases/download/v${LIANLI_VERSION}"; \
    cd /tmp; \
    curl -fsSLo "$deb" "$base/lian-li-linux_${LIANLI_VERSION}%2Bdebian13_amd64.deb"; \
    curl -fsSLo SHA256SUMS "$base/SHA256SUMS"; \
    grep " ${deb}\$" SHA256SUMS | sha256sum -c -; \
    apt-get update; \
    apt-get install -y --no-install-recommends "./$deb"; \
    rm -rf /var/lib/apt/lists/* /tmp/*

COPY rootfs/ /
# Strip CRLF in case the repo was checked out on Windows.
RUN sed -i 's/\r$//' /usr/local/bin/*.sh /etc/supervisor/supervisord.conf \
 && chmod +x /usr/local/bin/*.sh \
 && ln -sf vnc.html /usr/share/novnc/index.html

ENV DISPLAY=:0 \
    DISPLAY_WIDTH=1440 \
    DISPLAY_HEIGHT=900 \
    PUID=99 \
    PGID=100 \
    LOG_LEVEL=info \
    VNC_PASSWORD= \
    GDK_BACKEND=x11 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    LIBGL_ALWAYS_SOFTWARE=1 \
    NO_AT_BRIDGE=1

VOLUME ["/var/lib/lianli"]
EXPOSE 6080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
