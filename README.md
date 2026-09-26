# tor-middle-relay

A minimal, hardened Docker image for running a **pure Tor middle relay** —
no exit, no bridge, nothing else — with a small, read-only web dashboard.
Built on the official, signed Tor Project Debian packages and running as
unprivileged, non-root users.

Image: **[r600/tor-middle-relay](https://hub.docker.com/r/r600/tor-middle-relay)**

## What it does

- **Pure middle relay, enforced**: `ExitRelay 0`, `ExitPolicy reject *:*`,
  `IPv6Exit 0`, `BridgeRelay 0`, `SocksPort 0`. This node only forwards
  encrypted traffic between other Tor relays. It never originates exit
  traffic and is not a bridge. There is no setting to change this — see
  [Why this can never become an exit](#why-this-can-never-become-an-exit).
- **Dashboard**: live and historical traffic, connections, relay status and
  the effective settings, on `127.0.0.1:8080`.
- **Official Tor packages** from `deb.torproject.org`, GPG-verified. No
  self-compiled binaries.
- **Hardened**: non-root (`debian-tor`), `Sandbox 1`, `SafeLogging 1`,
  `DisableDebuggerAttachment 1`, `NoExec 1`, read-only root filesystem,
  all Linux capabilities dropped except `CHOWN`/`SETUID`/`SETGID` (needed
  once at start to drop privileges), `no-new-privileges`. The dashboard
  runs as a separate user that cannot read the relay's keys.
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

Open the dashboard at <http://127.0.0.1:8080> on the server — or, from
your own machine, through an SSH tunnel:

```bash
ssh -L 8080:127.0.0.1:8080 your-server
# then open http://127.0.0.1:8080
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
      # Dashboard: bound to localhost only. Reach it from another machine
      # through an SSH tunnel: ssh -L 8080:127.0.0.1:8080 your-server
      - "127.0.0.1:8080:8080"
    volumes:
      - tor-data:/var/lib/tor
      - dashboard-data:/var/lib/tor-dashboard
    # Everything is dropped except what the entrypoint needs to hand the
    # data directories to the service users and to drop privileges.
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETUID
      - SETGID
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
      - /etc/tor
      - /run/tor
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  tor-data:
  dashboard-data:
```

`.env`:

```ini
NICKNAME=MyMiddleRelay
CONTACT_INFO=Your Name <your-email@example.com>
OR_PORT=9001
```

Everything else has sensible defaults — see `.env.example` and the
[Configuration](#configuration) table.

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
      # Published here, not on the tor service, because the relay shares
      # this container's network namespace.
      - "9001:9001"
      # Dashboard of the relay, localhost only (see docker-compose.yml)
      - "127.0.0.1:8080:8080"
    security_opt:
      - no-new-privileges:true
    # No healthcheck override: gluetun ships its own HEALTHCHECK, which
    # checks the tunnel without calling a third-party IP lookup service.

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
      - dashboard-data:/var/lib/tor-dashboard
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - SETUID
      - SETGID
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp
      - /etc/tor
      - /run/tor
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  tor-data:
  dashboard-data:
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
| `NICKNAME` | Relay name, 1-19 letters/digits | *(required)* |
| `CONTACT_INFO` | Contact details so Tor admins can reach you | *(recommended)* |
| `OR_PORT` | Port for relay-to-relay traffic | `9001` |
| `OR_IPV6` | ORPort on IPv6: `auto` (if a global IPv6 address exists), `1`, `0` | `auto` |
| `RELAY_ADDRESS` | Public IP; only set if auto-detection fails | *(empty = auto)* |
| `DIR_CACHE` | Act as a directory cache (`0`/`1`) | `1` |
| `MYFAMILY` | Comma-separated fingerprints of your other relays | *(empty)* |
| `BANDWIDTH_RATE` | Sustained rate, e.g. `5 MBytes` | *(empty = unlimited)* |
| `BANDWIDTH_BURST` | Burst rate, e.g. `10 MBytes` | *(empty)* |
| `MAX_ADVERTISED_BANDWIDTH` | Bandwidth advertised in the directory | *(empty)* |
| `ACCOUNTING_MAX` | Total data volume cap, e.g. `500 GBytes` | *(empty = no cap)* |
| `ACCOUNTING_START` | Accounting period | `month 1 00:00` |
| `DASHBOARD_ENABLED` | Run the dashboard (`0`/`1`) | `1` |
| `DASHBOARD_PORT` | Dashboard port inside the container (change the `ports:` mapping too) | `8080` |
| `DASHBOARD_PASSWORD` | HTTP basic auth password (any username) | *(empty = none)* |
| `SANDBOX` | Tor's seccomp sandbox (`0`/`1`) — only disable if Tor fails with a sandbox error | `1` |

All values are validated at start (strict patterns, no line breaks); an
invalid value stops the container with a clear error instead of producing
a half-broken torrc. To check a configuration without starting the relay:

```bash
docker compose run --rm tor-middle-relay check
```

**On bandwidth:** Tor applies a single rate to both directions —
`RelayBandwidthRate` is not a separate download/upload limit. If you need
asymmetric shaping, do it on the host or router (e.g. `tc`), not in the
container.

## Why this can never become an exit

Exit traffic is not a setting in this image. Four independent layers make
sure of it:

1. **Input validation.** Every environment variable is checked against a
   strict pattern and may not contain line breaks, so nothing can smuggle
   an extra `ExitPolicy accept ...` line into the torrc. Only the listed
   variables are substituted into the template.
2. **Last word in the torrc.** The no-exit block (`ExitRelay 0`,
   `ExitPolicy reject *:*`, `IPv6Exit 0`, `BridgeRelay 0`, `SocksPort 0`)
   is the last block of the rendered torrc.
3. **Command line override.** The same options are passed to Tor on the
   command line, which beats the torrc — and for `ExitPolicy` *replaces*
   the whole list, so even a tampered torrc cannot open an exit.
4. **Verified before start, watched while running.** Before starting, the
   entrypoint asks Tor for its parsed configuration (`--dump-config`) and
   refuses to start unless it confirms all of the above. While running,
   the dashboard checks the effective exit policy every few seconds and
   halts Tor immediately if it ever accepts anything. The dashboard itself
   can only send read-only commands to Tor.

The CI workflow runs these checks (including injection attempts) against
every image before it is pushed.

## Dashboard

A small web page served from inside the container (Python standard
library, no external scripts, no CDN):

- **Live traffic**: received/sent rate over the last 10 minutes (1 s
  resolution) and the last 24 hours (1 min averages).
- **Traffic totals**: today, this month, all time, plus per-day bars for
  the last 30 days. Stored on the `dashboard-data` volume, so they survive
  restarts and image updates.
- **Connections**: number of Tor OR connections and established TCP
  connections (inbound on the ORPort / outbound). Only counts — no peer
  addresses are ever shown or logged.
- **Relay status**: Tor version, uptime, fingerprint, reachability,
  consensus flags and bandwidth, accounting (if enabled).
- **Settings**: the values Tor actually uses, with the exit-related ones
  highlighted.

It talks to Tor through a Unix control socket on a tmpfs (`/run/tor`), not
a TCP port, and runs as its own user (`tordash`) that can reach that
socket but not the relay's identity keys. It is read-only: no button,
form or API can change the relay.

The compose files publish it on `127.0.0.1` only. If you publish it on a
public interface anyway, set `DASHBOARD_PASSWORD` and put it behind a
TLS reverse proxy. Set `DASHBOARD_ENABLED=0` to turn it off completely
(the control socket is then not created either).

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

To automate it, add [Watchtower](https://github.com/nicholas-fedor/watchtower):

```yaml
  watchtower:
    image: nickfedor/watchtower:latest
    container_name: watchtower
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    command: --cleanup --schedule "0 0 5 * * *" tor-middle-relay
```

Note: this is the actively maintained fork. The original `containrrr/watchtower`
was archived in December 2025 and its pinned Docker API client is rejected by
current Docker engines, so it no longer works. The fork is a drop-in
replacement — same flags, same labels, only the image name changes.

Mounting the Docker socket gives that container full control over your Docker
daemon, which is effectively root on the host. If you'd rather not, a cron job
running `docker compose pull && docker compose up -d` does the same job with
less exposure.

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

The workflow also pushes this README to the Docker Hub repository page —
that's a separate API call, which is why an image push alone leaves the
Docker Hub overview empty.

That step needs a token with **read/write/delete** scope. A plain push token
(read/write) gets a 403 from the description API. Two options:

- Give `DOCKERHUB_TOKEN` read/write/delete scope, or
- Keep the push token narrow and add a second secret,
  `DOCKERHUB_DESCRIPTION_TOKEN`, with read/write/delete — the workflow uses
  it when present and falls back to `DOCKERHUB_TOKEN` otherwise

The step is marked `continue-on-error`, so a missing or under-scoped token
logs a warning instead of failing the build. Docker Hub truncates the README
at 25,000 bytes and the short description at 100.

Tagging a release also publishes versioned tags:

```bash
git tag v1.0.0
git push origin v1.0.0
```

## Notes

- **Back up `/var/lib/tor`.** It holds the relay's private identity keys.
  Losing them means starting over from zero reputation.
- **Only the ORPort is exposed publicly.** No SocksPort, no forced
  DirPort, no control port. The dashboard is on `127.0.0.1` only.
- **Guard flag:** after a few weeks of stable uptime the directory
  authorities may give your relay the `Guard` flag. It is then also used
  as the first hop of circuits, so Tor users connect to it directly. That
  is normal and still not an exit — but it means your relay sees client
  IP addresses (never their destinations). `SafeLogging 1` keeps them out
  of the logs, and the dashboard never shows peer addresses.
- **Ports below 1024** work as ORPort without extra capabilities (Docker
  allows unprivileged binding inside containers by default).
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
├── dashboard/
│   ├── server.py
│   └── static/  (index.html, app.js, style.css)
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
