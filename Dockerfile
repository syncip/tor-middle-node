# Debian release for the base image AND the Tor Project repository.
# Both must match. trixie is the current Debian stable (bookworm left
# regular security support in June 2026).
ARG DEBIAN_SUITE=trixie
FROM debian:${DEBIAN_SUITE}-slim
ARG DEBIAN_SUITE

LABEL org.opencontainers.image.title="tor-middle-relay" \
      org.opencontainers.image.description="Minimal, hardened Tor middle relay (no exit, no bridge) with a small read-only dashboard" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/syncip/tor-middle-node"

ARG DEBIAN_FRONTEND=noninteractive

# --- Runtime tools -----------------------------------------------------
# python3 runs the dashboard (standard library only, no pip packages).
RUN set -eux; \
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        gettext-base \
        gosu \
        procps \
        iproute2 \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# --- Official Tor Project apt repository (signed packages) -----------
# curl and gnupg are only needed to fetch and check the signing key; they
# are removed again in the same layer, so they don't ship in the image.
ARG TOR_KEY_FPR=A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends curl gnupg; \
    curl -fsSL -o /tmp/tor.asc "https://deb.torproject.org/torproject.org/${TOR_KEY_FPR}.asc"; \
    gpg --show-keys --with-colons /tmp/tor.asc | grep -q "^fpr:*${TOR_KEY_FPR}:"; \
    gpg --dearmor -o /usr/share/keyrings/deb.torproject.org-keyring.gpg /tmp/tor.asc; \
    rm -f /tmp/tor.asc; \
    echo "deb [signed-by=/usr/share/keyrings/deb.torproject.org-keyring.gpg] https://deb.torproject.org/torproject.org ${DEBIAN_SUITE} main" \
        > /etc/apt/sources.list.d/tor.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends tor deb.torproject.org-keyring; \
    apt-mark auto curl gnupg >/dev/null; \
    apt-get autoremove -y --purge; \
    rm -rf /var/lib/apt/lists/* /root/.gnupg; \
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
