FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="tor-middle-relay" \
      org.opencontainers.image.description="Minimal, hardened Tor middle relay (no exit, no bridge) with a small read-only dashboard" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/syncip/tor-middle-node"

ARG DEBIAN_FRONTEND=noninteractive

# --- Base tools ------------------------------------------------------
# python3 runs the dashboard (standard library only, no pip packages).
RUN set -eux; \
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg2 \
        gettext-base \
        gosu \
        procps \
        iproute2 \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# --- Official Tor Project apt repository (signed packages) -----------
RUN set -eux; \
    curl -fsSL https://deb.torproject.org/torproject.org/A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89.asc \
        | gpg --dearmor -o /usr/share/keyrings/deb.torproject.org-keyring.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/deb.torproject.org-keyring.gpg] https://deb.torproject.org/torproject.org bookworm main" \
        > /etc/apt/sources.list.d/tor.list; \
    apt-get update && apt-get install -y --no-install-recommends \
        tor \
        deb.torproject.org-keyring \
    && rm -rf /var/lib/apt/lists/*; \
    tor --version | head -1 > /etc/tor-version

# Record the installed Tor version so it can be inspected without starting
# the container:  docker run --rm --entrypoint cat IMAGE /etc/tor-version

# --- Dashboard user ----------------------------------------------------
# Separate unprivileged user. Member of group debian-tor only to reach the
# control socket in /run/tor - it cannot read the relay's keys in
# /var/lib/tor (mode 700, owned by debian-tor).
RUN set -eux; \
    useradd --system --no-create-home --home-dir /nonexistent \
        --shell /usr/sbin/nologin --groups debian-tor tordash

# --- Configuration & entrypoint ---------------------------------------
# The template lives outside /etc/tor on purpose: the container runs with
# a read-only root filesystem, so /etc/tor is a tmpfs the entrypoint can
# render the final torrc into on every start.
COPY torrc.template /etc/tor-template/torrc.template
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY dashboard/ /opt/dashboard/

RUN set -eux; \
    chmod 755 /usr/local/bin/entrypoint.sh; \
    chmod -R a+rX,go-w /opt/dashboard; \
    mkdir -p /var/lib/tor /etc/tor /run/tor /var/lib/tor-dashboard; \
    chown -R debian-tor:debian-tor /var/lib/tor /run/tor; \
    chmod 700 /var/lib/tor; \
    chmod 750 /run/tor; \
    chown tordash:tordash /var/lib/tor-dashboard; \
    chmod 700 /var/lib/tor-dashboard

# ORPort (public) and dashboard (publish on 127.0.0.1 only!).
EXPOSE 9001 8080

HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
    CMD sh -c 'pgrep -x tor >/dev/null && ss -tlnH "sport = :${OR_PORT:-9001}" | grep -q .'

VOLUME ["/var/lib/tor", "/var/lib/tor-dashboard"]

# Starts as root only to render the config, then drops privileges to the
# unprivileged debian-tor / tordash users via gosu. Tor ends up as PID 1
# and receives docker's SIGTERM directly. (No tini: a root init without
# CAP_KILL is not allowed to forward signals to the debian-tor process.)
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
