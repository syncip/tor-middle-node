FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="tor-middle-relay" \
      org.opencontainers.image.description="Minimal, hardened Tor middle relay (no exit, no bridge)" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/syncip/tor-middle-node"

ARG DEBIAN_FRONTEND=noninteractive

# --- Base tools ------------------------------------------------------
RUN set -eux; \
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        gnupg2 \
        gettext-base \
        gosu \
        procps \
        iproute2 \
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
    && rm -rf /var/lib/apt/lists/*

# --- Configuration & entrypoint ---------------------------------------
# The template lives outside /etc/tor on purpose: the container runs with
# a read-only root filesystem, so /etc/tor is a tmpfs the entrypoint can
# render the final torrc into on every start.
COPY torrc.template /etc/tor-template/torrc.template
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN set -eux; \
    chmod +x /usr/local/bin/entrypoint.sh; \
    mkdir -p /var/lib/tor /etc/tor; \
    chown -R debian-tor:debian-tor /var/lib/tor; \
    chmod 700 /var/lib/tor

# Only the ORPort is exposed. No SocksPort, no forced DirPort.
EXPOSE 9001

HEALTHCHECK --interval=60s --timeout=5s --start-period=60s --retries=3 \
    CMD sh -c 'pgrep -x tor >/dev/null && ss -tln 2>/dev/null | grep -q ":${OR_PORT:-9001} "'

VOLUME ["/var/lib/tor"]

# Starts as root only to render the config, then drops privileges to the
# unprivileged debian-tor user via gosu.
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
