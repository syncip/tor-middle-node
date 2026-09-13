# tor-middle-relay

A minimal, hardened Docker image for running a **pure Tor middle relay** —
no exit, no bridge, nothing else. Built on the official, signed Tor Project
Debian packages and running as an unprivileged, non-root user.

Image: **[r600/tor-middle-relay](https://hub.docker.com/r/r600/tor-middle-relay)**

## What it does

- **Pure middle relay**: `ExitRelay 0`, `ExitPolicy reject *:*`, `IPv6Exit 0`,
  `BridgeRelay 0`, `SocksPort 0`. This node only forwards encrypted traffic
  between other Tor relays. It never originates exit traffic and is not a bridge.
- **Official Tor packages** from `deb.torproject.org`, GPG-verified. No
  self-compiled binaries.
- **Hardened**: non-root (`debian-tor`), `Sandbox 1`, `SafeLogging 1`,
  `DisableDebuggerAttachment 1`, `NoExec 1`, read-only root filesystem,
  all Linux capabilities dropped, `no-new-privileges`.
- **Persistent identity** via a Docker volume. Without it the relay gets a
  new identity on every restart and loses all accumulated reputation.
- **Multi-arch**: `linux/amd64` and `linux/arm64`.

## Quick start

```bash
git clone https://github.com/syncip/tor-middle-node.git
cd tor-middle-node
cp .env.example .env
# edit .env: set NICKNAME and CONTACT_INFO
docker compose up -d
docker compose logs -f
```

Watch the logs for `Self-testing indicates your ORPort ... is reachable`.
It can take a few hours before the relay shows up in the public Tor
consensus, and several days before it carries meaningful traffic.

## Example 1: plain middle relay

`docker-compose.yml`:

```yaml
services:
  tor-middle-relay:
    image: r600/tor-middle-relay:latest
    container_name: tor-middle-relay
    restart: unless-stopped
    env_file:
      - .env
    ports:
      - "9001:9001"
    volumes:
      - tor-data:/var/lib/tor
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
      - /etc/tor
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  tor-data:
```

`.env`:

```ini
NICKNAME=MyMiddleRelay
CONTACT_INFO=Your Name <your-email@example.com>
OR_PORT=9001
RELAY_ADDRESS=
DIR_CACHE=1
MYFAMILY=

# Optional cap, leave empty for unlimited
BANDWIDTH_RATE=
BANDWIDTH_BURST=
MAX_ADVERTISED_BANDWIDTH=
ACCOUNTING_MAX=
ACCOUNTING_START=month 1 00:00
```

```bash
docker compose up -d
```

## Example 2: middle relay behind gluetun (VPN)

The gluetun container owns the network stack and the relay joins it with
`network_mode: "service:gluetun"`. The relay therefore has no `ports:`
section of its own — the ORPort is published on the gluetun service.

> **Your VPN provider must support port forwarding**, and the forwarded port
> has to reach the relay's ORPort. A relay whose ORPort is unreachable from
> the outside will never be included in the consensus. Also note that many
> VPN providers prohibit running Tor relays over their service — check their
> terms first.

`docker-compose.gluetun.yml`:

```yaml
services:
  gluetun:
    image: qmcgaw/gluetun:latest
    container_name: tor-relay-gluetun
    restart: unless-stopped
    cap_add:
      - NET_ADMIN
    devices:
      - /dev/net/tun:/dev/net/tun
    env_file:
      - .env.gluetun
    ports:
      - "9001:9001"   # published here, not on the tor service
    security_opt:
      - no-new-privileges:true
    healthcheck:
      test: ["CMD", "wget", "-qO-", "https://api.ipify.org"]
      interval: 30s
      timeout: 10s
      retries: 5

  tor-middle-relay:
    image: r600/tor-middle-relay:latest
    container_name: tor-middle-relay
    restart: unless-stopped
    network_mode: "service:gluetun"
    depends_on:
      gluetun:
        condition: service_healthy
    env_file:
      - .env
    volumes:
      - tor-data:/var/lib/tor
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
      - /etc/tor

volumes:
  tor-data:
```

`.env.gluetun` (WireGuard example — see the
[gluetun wiki](https://github.com/qdm12/gluetun-wiki) for your provider):

```ini
VPN_SERVICE_PROVIDER=your_provider
VPN_TYPE=wireguard
WIREGUARD_PRIVATE_KEY=your_private_key
WIREGUARD_ADDRESSES=10.0.0.2/32
SERVER_COUNTRIES=Netherlands

# Let inbound ORPort connections through the tunnel
FIREWALL_INPUT_PORTS=9001
```

In `.env`, set `RELAY_ADDRESS` to the VPN's public IP if Tor's
auto-detection picks the wrong address:

```ini
RELAY_ADDRESS=203.0.113.10
```

```bash
cp .env.example .env
cp .env.gluetun.example .env.gluetun
docker compose -f docker-compose.gluetun.yml up -d
```

## Configuration

| Variable | Description | Default |
|---|---|---|
| `NICKNAME` | Relay name, max 19 alphanumeric chars | *(required)* |
| `CONTACT_INFO` | Contact details so Tor admins can reach you | *(recommended)* |
| `OR_PORT` | Port for relay-to-relay traffic | `9001` |
| `RELAY_ADDRESS` | Public IP; only set if auto-detection fails | *(empty = auto)* |
| `DIR_CACHE` | Act as a directory cache (`0`/`1`) | `1` |
| `MYFAMILY` | Comma-separated fingerprints of your other relays | *(empty)* |
| `BANDWIDTH_RATE` | Sustained rate, e.g. `5 MBytes` | *(empty = unlimited)* |
| `BANDWIDTH_BURST` | Burst rate, e.g. `10 MBytes` | *(empty)* |
| `MAX_ADVERTISED_BANDWIDTH` | Bandwidth advertised in the directory | *(empty)* |
| `ACCOUNTING_MAX` | Total data volume cap, e.g. `500 GBytes` | *(empty = no cap)* |
| `ACCOUNTING_START` | Accounting period | `month 1 00:00` |

**On bandwidth:** Tor applies a single rate to both directions —
`RelayBandwidthRate` is not a separate download/upload limit. If you need
asymmetric shaping, do it on the host or router (e.g. `tc`), not in the
container.

## Keeping Tor up to date

The Tor version is baked into the image at build time — the container does
**not** update itself, and restarting it changes nothing. This matters for a
relay: the directory authorities reject end-of-life Tor versions, so a relay
left on an old version will eventually be dropped from the consensus. Tor
warns about this in the logs (`Please upgrade! This version of Tor is
obsolete...`) well before it happens.

Two things keep this current:

**1. The image gets rebuilt weekly.** The workflow has a `schedule` trigger
that rebuilds every Monday, picking up new Tor releases and Debian security
updates without needing a commit. Scheduled runs set `no-cache: true` — this
is deliberate and important: with the layer cache active, the
`apt-get install tor` layer would be reused and the "rebuild" would ship the
exact same old version. You can also trigger this manually via
**Actions → Build and Publish Docker Image → Run workflow**, optionally
ticking "Build without cache".

**2. Your host has to pull the new image.** A rebuilt image on Docker Hub
doesn't reach your server on its own:

```bash
docker compose pull
docker compose up -d
```

To automate it, add [Watchtower](https://github.com/containrrr/watchtower):

```yaml
  watchtower:
    image: containrrr/watchtower:latest
    container_name: watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --cleanup --schedule "0 0 5 * * *" tor-middle-relay
```

Recreating the container is safe — the relay's identity keys live on the
`tor-data` volume, so the fingerprint and accumulated reputation survive the
update. Expect a short dip in traffic while the relay reconnects.

Check which version is running:

```bash
docker compose logs tor-middle-relay | grep "Tor version"
```

Or inspect an image without starting it:

```bash
docker run --rm --entrypoint cat r600/tor-middle-relay:latest /etc/tor-version
```

## Publishing to Docker Hub

`.github/workflows/docker-publish.yml` builds for `amd64` and `arm64` and
pushes to `r600/tor-middle-relay` on every push to `main` and on `v*.*.*`
tags. Add two repository secrets under
**Settings → Secrets and variables → Actions**:

- `DOCKERHUB_USERNAME` — your Docker Hub username
- `DOCKERHUB_TOKEN` — a Docker Hub access token (Docker Hub → Account
  Settings → Personal access tokens), **not** your password

Tagging a release also publishes versioned tags:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Notes

- **Back up `/var/lib/tor`.** It holds the relay's private identity keys.
  Losing them means starting over from zero reputation.
- **Only the ORPort is exposed.** No SocksPort, no forced DirPort.
- **Legal context:** a middle relay only forwards already-encrypted traffic
  between Tor relays and never appears as the source IP of exit traffic —
  far less legally sensitive than an exit relay. Still, check your
  hosting/VPS provider's terms; some prohibit Tor relays entirely.
- Check your relay's status at [Tor Metrics](https://metrics.torproject.org/rs.html)
  once it appears in the consensus.

## Files

```
.
├── Dockerfile
├── torrc.template
├── entrypoint.sh
├── docker-compose.yml
├── docker-compose.gluetun.yml
├── .env.example
├── .env.gluetun.example
├── .gitignore
├── .dockerignore
└── .github/workflows/docker-publish.yml
```

## License

MIT
