FROM debian:bookworm-slim

LABEL org.opencontainers.image.title="tor-middle-relay" \
      org.opencontainers.image.description="Minimaler, gehaerteter Tor Middle-Relay Container (kein Exit, keine Bridge) mit optionalem Bandbreiten-Shaping" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/CHANGE_ME/tor-middle-relay"

ARG DEBIAN_FRONTEND=noninteractive

# --- Basis-Tools ---------------------------------------------------------
RUN set -eux; \
    apt-get update && apt-get install -y --no-install-recommends \
        gnupg2 \
        ca-certificates \
        curl \
        gettext-base \
        gosu \
        iproute2 \
        kmod \
        iputils-ping \
    && rm -rf /var/lib/apt/lists/*

# --- Offizielles Tor-Project-Repository (signierte Pakete, aktuelle Version) ---
RUN set -eux; \
    curl -fsSL https://deb.torproject.org/torproject.org/A3C4F0F979CAA22CDBA8F512EE8CBC9E886DDD89.asc \
        | gpg --dearmor -o /usr/share/keyrings/deb.torproject.org-keyring.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/deb.torproject.org-keyring.gpg] https://deb.torproject.org/torproject.org bookworm main" \
        > /etc/apt/sources.list.d/tor.list; \
    apt-get update && apt-get install -y --no-install-recommends \
        tor \
        deb.torproject.org-keyring \
    && rm -rf /var/lib/apt/lists/*

# --- Konfiguration & Entrypoint ------------------------------------------
COPY torrc.template /etc/tor/torrc.template
COPY entrypoint.sh /usr/local/bin/entrypoint.sh

RUN set -eux; \
    chmod +x /usr/local/bin/entrypoint.sh; \
    mkdir -p /var/lib/tor; \
    chown -R debian-tor:debian-tor /var/lib/tor; \
    chmod 700 /var/lib/tor

# Nur der ORPort wird nach aussen exponiert. Kein SocksPort, kein DirPort-Zwang.
EXPOSE 9001

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
    CMD sh -c 'pgrep -x tor >/dev/null && ss -tln 2>/dev/null | grep -q ":${OR_PORT:-9001} "' || exit 1

VOLUME ["/var/lib/tor"]

# Entrypoint startet als root (fuer optionales tc-Shaping) und wechselt
# danach selbst per gosu zu debian-tor, siehe entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
