# Lian Li Linux (https://github.com/sgtaziz/lian-li-linux) packaged for Unraid.
#
# Runs the hardware daemon in system mode plus a web dashboard. The upstream
# desktop GUI is not used: the dashboard does its job.

ARG LIANLI_VERSION=1.2.5

# Build the daemon from the same release with the fixes in patches/ applied.
# The rest of the package (users, udev rules, ffmpeg) comes from the .deb below.
FROM rust:1-trixie AS daemon
ARG LIANLI_VERSION
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      clang cmake nasm pkg-config patch \
      libusb-1.0-0-dev libudev-dev libfontconfig-dev libdrm-dev \
      libavcodec-dev libavformat-dev libswscale-dev libavutil-dev libavfilter-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY patches/ /patches/
RUN set -eux; \
    git clone --depth 1 --branch "v${LIANLI_VERSION}" --recurse-submodules \
      https://github.com/sgtaziz/lian-li-linux.git .; \
    for p in /patches/*.patch; do sed -i 's/\r$//' "$p"; patch -p1 --forward < "$p"; done; \
    cargo build --locked --release -p lianli-daemon; \
    strip target/release/lianli-daemon

FROM debian:trixie-slim

ARG LIANLI_VERSION
ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl \
      supervisor procps tzdata nodejs fontconfig \
      fonts-dejavu-core fonts-noto-color-emoji \
 && rm -rf /var/lib/apt/lists/*

# Install the upstream Debian 13 release package, verified against SHA256SUMS.
# Its postinst creates the `lianli` system user and the shared lock files. The
# package depends on the GUI's libraries, so they stay, but the GUI itself goes.
RUN set -eux; \
    deb="lian-li-linux_${LIANLI_VERSION}+debian13_amd64.deb"; \
    base="https://github.com/sgtaziz/lian-li-linux/releases/download/v${LIANLI_VERSION}"; \
    cd /tmp; \
    curl -fsSLo "$deb" "$base/lian-li-linux_${LIANLI_VERSION}%2Bdebian13_amd64.deb"; \
    curl -fsSLo SHA256SUMS "$base/SHA256SUMS"; \
    awk -v f="$deb" '$2 == f || $2 == "./" f' SHA256SUMS | grep . | sha256sum -c -; \
    apt-get update; \
    apt-get install -y --no-install-recommends "./$deb"; \
    rm -f /usr/bin/lianli-gui; \
    rm -rf /var/lib/apt/lists/* /tmp/*

# Swap in the patched daemon built above.
COPY --from=daemon /src/target/release/lianli-daemon /usr/bin/lianli-daemon

COPY rootfs/ /
# Strip CRLF in case the repo was checked out on Windows.
RUN sed -i 's/\r$//' /usr/local/bin/*.sh /etc/supervisor/supervisord.conf \
 && chmod +x /usr/local/bin/*.sh

ENV PUID=99 \
    PGID=100 \
    LOG_LEVEL=info \
    RESET_PASSWORD=no

VOLUME ["/var/lib/lianli"]
EXPOSE 6090

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
