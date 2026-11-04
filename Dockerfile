# Lian Li Linux (https://github.com/sgtaziz/lian-li-linux) packaged for Unraid.
#
# Runs the hardware daemon in system mode plus a web dashboard. The upstream
# desktop GUI is not used: the dashboard does its job.

FROM debian:trixie-slim

ARG LIANLI_VERSION=1.2.4
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

COPY rootfs/ /
# Strip CRLF in case the repo was checked out on Windows.
RUN sed -i 's/\r$//' /usr/local/bin/*.sh /etc/supervisor/supervisord.conf \
 && chmod +x /usr/local/bin/*.sh

ENV PUID=99 \
    PGID=100 \
    LOG_LEVEL=info \
    WEB_PASSWORD=

VOLUME ["/var/lib/lianli"]
EXPOSE 6090

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
