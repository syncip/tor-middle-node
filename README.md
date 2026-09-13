# tor-middle-relay

Minimaler, gehärteter Docker-Container für einen **reinen Tor Middle-Relay**
(kein Exit, keine Bridge). Basiert auf dem offiziellen, signierten
Debian-Paket-Repository des Tor Projects und läuft standardmäßig als
Non-Root-User (`debian-tor`).

## Eigenschaften

- **Reiner Middle-Relay**: `ExitRelay 0`, `ExitPolicy reject *:*`, `BridgeRelay 0`
  – dieser Node leitet ausschließlich Traffic zwischen anderen Relays weiter
  und initiiert selbst keine Exit-Verbindungen ins offene Internet.
- **Offizielle Tor-Pakete**: Installation über `deb.torproject.org` inkl.
  GPG-Signaturprüfung, keine selbst kompilierten Binaries.
- **Hardening**: `Sandbox 1`, `SafeLogging 1`, `DisableDebuggerAttachment 1`,
  `NoExec 1`, `AvoidDiskWrites 1`, Ausführung als Non-Root.
- **Bandbreiten-Limit**: Standardmäßig 5 MB/s Download / 1 MB/s Upload
  (konfigurierbar), umgesetzt über zwei sich ergänzende Mechanismen (siehe
  unten).
- **Persistente Relay-Identität** über ein Docker-Volume – wichtig, da ein
  Relay ohne persistente Keys bei jedem Neustart seine Reputation im
  Tor-Netzwerk verliert.
- **Healthcheck** und `docker logs`-taugliches Logging (stdout).
- **GitHub Actions Workflow**, der das Image automatisch für `amd64` und
  `arm64` baut und nach Docker Hub pusht.

## Wichtiger Hinweis zur Bandbreite

Tor selbst besitzt **kein natives, getrenntes Down-/Upload-Limit** – die
Einstellung `RelayBandwidthRate` gilt für beide Richtungen gleichermaßen.
Dieses Setup kombiniert deshalb zwei Ebenen:

1. **Tor-internes Limit** (`BANDWIDTH_RATE` in `.env`): symmetrisches
   Sicherheitsnetz, standardmäßig auf den niedrigeren der beiden Werte
   (Upload) gesetzt, damit Tor nie mehr anfragt, als die schwächste Leitung
   hergibt.
2. **Echtes asymmetrisches Shaping via `tc`/`ifb`** (Linux Traffic Control)
   im Entrypoint-Skript, aktivierbar über `ENABLE_TC_SHAPING=true`. Das
   erzwingt die getrennten Limits auf Netzwerkinterface-Ebene.

Für Punkt 2 muss der Container mit der Capability `NET_ADMIN` gestartet
werden (siehe `docker-compose.yml`). Das funktioniert zuverlässig auf einem
Linux-Host (VPS, dediziertem Server); in manchen Cloud-Overlay-Netzwerken
oder unter Docker Desktop (Mac/Windows) kann das Ingress-Shaping
eingeschränkt sein. Falls es dort nicht greift, bleibt zumindest das
Tor-interne, symmetrische Limit aktiv.

## Schnellstart

```bash
git clone https://github.com/DEIN_USER/tor-middle-relay.git
cd tor-middle-relay
cp .env.example .env
# .env anpassen: NICKNAME, CONTACT_INFO, ggf. Bandbreiten-Werte

docker compose up -d --build
docker compose logs -f
```

Nach ein paar Minuten solltest du in den Logs sehen, dass der Relay als
"Self-testing indicates ... OR port reachable" bzw. "Registered server
descriptor" meldet. Es kann bis zu ein paar Stunden dauern, bis der Relay im
öffentlichen Tor-Verzeichnis (Consensus) auftaucht.

## Konfiguration (`.env`)

| Variable                     | Beschreibung                                                       | Default                |
|-------------------------------|---------------------------------------------------------------------|-------------------------|
| `NICKNAME`                   | Relay-Name (max. 19 Zeichen, alphanumerisch)                        | *(Pflicht)*             |
| `CONTACT_INFO`                | Kontaktinfo, damit dich Tor-Admins bei Problemen erreichen können     | *(empfohlen)*           |
| `OR_PORT`                     | Port für Relay-zu-Relay-Traffic                                     | `9001`                  |
| `RELAY_ADDRESS`               | Öffentliche IP, nur setzen falls Auto-Erkennung fehlschlägt          | *(leer = auto)*         |
| `DIR_CACHE`                   | Als Verzeichnis-Cache mithelfen (`0`/`1`)                            | `1`                     |
| `MYFAMILY`                    | Fingerprints weiterer eigener Relays, kommagetrennt                 | *(leer)*                |
| `BANDWIDTH_RATE`              | Tor-internes, symmetrisches Dauerlimit                              | `1 MBytes`              |
| `BANDWIDTH_BURST`             | Tor-internes Burst-Limit                                            | `2 MBytes`              |
| `MAX_ADVERTISED_BANDWIDTH`    | Im Verzeichnis beworbene Bandbreite                                 | `1 MBytes`              |
| `ACCOUNTING_MAX`              | Optionales Datenvolumen-Limit, z.B. `500 GBytes`                    | *(leer = kein Limit)*   |
| `ACCOUNTING_START`            | Abrechnungszeitraum, z.B. `month 1 00:00`                           | `month 1 00:00`         |
| `ENABLE_TC_SHAPING`           | Echtes asymmetrisches Down-/Upload-Limit aktivieren                 | `true`                  |
| `IFACE`                       | Netzwerkinterface im Container für das Shaping                      | `eth0`                  |
| `DOWNLOAD_LIMIT_MBIT`         | Download-Limit in Mbit/s (5 MB/s ≈ 40)                              | `40`                    |
| `UPLOAD_LIMIT_MBIT`           | Upload-Limit in Mbit/s (1 MB/s ≈ 8)                                 | `8`                     |

## Auf Docker Hub veröffentlichen

### Manuell

```bash
docker build -t DEIN_DOCKERHUB_USER/tor-middle-relay:latest .
docker login
docker push DEIN_DOCKERHUB_USER/tor-middle-relay:latest
```

### Automatisch per GitHub Actions

Der mitgelieferte Workflow (`.github/workflows/docker-publish.yml`) baut das
Image bei jedem Push auf `main` (und bei Git-Tags `v*.*.*`) für `amd64` und
`arm64` und pusht es nach Docker Hub. Dafür in den Repo-Settings unter
**Settings → Secrets and variables → Actions** zwei Secrets anlegen:

- `DOCKERHUB_USERNAME` – dein Docker-Hub-Benutzername
- `DOCKERHUB_TOKEN` – ein Docker-Hub-Access-Token (kein Passwort; erstellbar
  unter Docker Hub → Account Settings → Security → New Access Token)

## Sicherheits- und Betriebshinweise

- **Relay-Keys sichern**: Das Volume `tor-data` (bzw. `/var/lib/tor`) enthält
  die private Identität des Relays. Backup empfohlen, sonst verliert der
  Relay bei Datenverlust seine im Netzwerk aufgebaute Reputation.
- **Nur `ORPort` exponieren**: Es wird bewusst kein `SocksPort` nach außen
  geöffnet und kein `DirPort` erzwungen.
- **Rechtliche Lage**: Ein Middle-Relay leitet nur verschlüsselten Traffic
  zwischen anderen Tor-Relays weiter und erscheint nicht als Ursprungs-IP von
  Exit-Traffic – rechtlich deutlich unkritischer als ein Exit-Relay. Prüfe
  trotzdem die Nutzungsbedingungen deines Hosting-/VPS-Anbieters, manche
  untersagen Tor-Relays generell.
- **`NET_ADMIN`-Capability**: Wird nur für das `tc`-Shaping benötigt. Wenn du
  `ENABLE_TC_SHAPING=false` setzt, kannst du `cap_add: [NET_ADMIN]` aus der
  `docker-compose.yml` entfernen und läufst mit minimalen Rechten.

## Projektstruktur

```
.
├── Dockerfile
├── torrc.template
├── entrypoint.sh
├── docker-compose.yml
├── .env.example
├── .gitignore
├── .dockerignore
└── .github/workflows/docker-publish.yml
```

## Lizenz

MIT
