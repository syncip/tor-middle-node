#!/bin/bash
set -euo pipefail

# ============================================================
# Tor middle relay entrypoint
#
#   entrypoint.sh          render + verify config, start dashboard, run Tor
#   entrypoint.sh check    render + verify config, print it, exit
#
# Runs as root only to prepare directories and render the config, then
# drops privileges via gosu. Needs the capabilities CHOWN, SETUID and
# SETGID (see docker-compose.yml) - nothing else.
# ============================================================

log() { echo "[entrypoint] $*"; }
die() { echo "[entrypoint] ERROR: $*" >&2; exit 1; }

MODE="${1:-run}"
case "${MODE}" in
  run|check) ;;
  *) die "unknown argument '${MODE}' (expected: run | check)" ;;
esac

# ============================================================
# Environment variables (see README.md / .env.example)
# ============================================================
: "${NICKNAME:?NICKNAME must be set, e.g. -e NICKNAME=MyMiddleRelay}"
: "${CONTACT_INFO:=}"
: "${OR_PORT:=9001}"
: "${OR_IPV6:=auto}"        # auto | 1 | 0
: "${RELAY_ADDRESS:=}"      # leave empty to let Tor auto-detect the public IP
: "${DIR_CACHE:=1}"
: "${MYFAMILY:=}"
: "${SANDBOX:=1}"

# Optional bandwidth cap. Leave empty for no cap (Tor's default).
# Format: "<number> <unit>", e.g. "5 MBytes". Tor applies one rate to
# BOTH directions - there is no separate download/upload limit.
: "${BANDWIDTH_RATE:=}"
: "${BANDWIDTH_BURST:=}"
: "${MAX_ADVERTISED_BANDWIDTH:=}"

# Optional total data volume cap
: "${ACCOUNTING_MAX:=}"
: "${ACCOUNTING_START:=month 1 00:00}"

# Dashboard
: "${DASHBOARD_ENABLED:=1}"
: "${DASHBOARD_PORT:=8080}"
: "${DASHBOARD_PASSWORD:=}"

CONTROL_DIR=/run/tor
DASHBOARD_DATA=/var/lib/tor-dashboard

# ============================================================
# Validation
#
# Every value ends up in the torrc. A value containing a newline could
# smuggle in extra lines such as "ExitPolicy accept *:*", so every value
# is checked against a strict pattern before rendering.
# ============================================================
for var in NICKNAME CONTACT_INFO OR_PORT OR_IPV6 RELAY_ADDRESS DIR_CACHE MYFAMILY \
           SANDBOX BANDWIDTH_RATE BANDWIDTH_BURST MAX_ADVERTISED_BANDWIDTH \
           ACCOUNTING_MAX ACCOUNTING_START DASHBOARD_ENABLED DASHBOARD_PORT \
           DASHBOARD_PASSWORD; do
  value="${!var}"
  if [[ "${value}" == *$'\n'* || "${value}" == *$'\r'* ]]; then
    die "${var} must not contain line breaks"
  fi
  if [[ "${value}" =~ [[:cntrl:]] ]]; then
    die "${var} must not contain control characters"
  fi
done

match() { [[ "$2" =~ $3 ]] || die "$1='$2' is invalid ($4)"; }

match NICKNAME "${NICKNAME}" '^[A-Za-z0-9]{1,19}$' "1-19 letters/digits"
match OR_PORT "${OR_PORT}" '^[0-9]{1,5}$' "port number"
(( OR_PORT >= 1 && OR_PORT <= 65535 )) || die "OR_PORT must be 1-65535"
match OR_IPV6 "${OR_IPV6}" '^(auto|0|1)$' "auto, 0 or 1"
match DIR_CACHE "${DIR_CACHE}" '^[01]$' "0 or 1"
match SANDBOX "${SANDBOX}" '^[01]$' "0 or 1"
match DASHBOARD_ENABLED "${DASHBOARD_ENABLED}" '^[01]$' "0 or 1"
match DASHBOARD_PORT "${DASHBOARD_PORT}" '^[0-9]{1,5}$' "port number"
(( DASHBOARD_PORT >= 1 && DASHBOARD_PORT <= 65535 )) || die "DASHBOARD_PORT must be 1-65535"
[ "${DASHBOARD_ENABLED}" = 0 ] || [ "${DASHBOARD_PORT}" != "${OR_PORT}" ] \
  || die "DASHBOARD_PORT and OR_PORT must differ"

if [ -n "${RELAY_ADDRESS}" ]; then
  match RELAY_ADDRESS "${RELAY_ADDRESS}" '^[A-Za-z0-9.:-]+$|^\[[0-9A-Fa-f:.]+\]$' "IP address or hostname"
fi

MYFAMILY="${MYFAMILY//[[:space:]]/}"
if [ -n "${MYFAMILY}" ]; then
  match MYFAMILY "${MYFAMILY}" '^\$?[0-9A-Fa-f]{40}(,\$?[0-9A-Fa-f]{40})*$' \
    "comma-separated 40-character hex fingerprints"
fi

size_re='^[0-9]+ ?[A-Za-z]*$'
for var in BANDWIDTH_RATE BANDWIDTH_BURST MAX_ADVERTISED_BANDWIDTH ACCOUNTING_MAX; do
  [ -z "${!var}" ] || match "${var}" "${!var}" "${size_re}" "e.g. '5 MBytes'"
done
match ACCOUNTING_START "${ACCOUNTING_START}" \
  '^(day|week|month)( [0-9]{1,2})?( [0-9]{1,2}:[0-9]{2})?$' "e.g. 'month 1 00:00'"

if [ -n "${CONTACT_INFO}" ]; then
  # Printable single-line text; a leading "%" would be read as a
  # torrc directive such as %include.
  [[ "${CONTACT_INFO}" != %* ]] || die "CONTACT_INFO must not start with '%'"
  CONTACT_LINE="ContactInfo ${CONTACT_INFO}"
else
  log "WARNING: CONTACT_INFO is not set. Please set it so the Tor Project"
  log "         can reach you if something is wrong with your relay."
  CONTACT_LINE=""
fi

# ============================================================
# Build optional config blocks
# ============================================================
has_global_ipv6() {
  # /proc/net/if_inet6: addr idx prefixlen scope flags iface; scope 00 = global
  [ -r /proc/net/if_inet6 ] && awk '$4 == "00" && $6 != "lo" {f=1} END {exit !f}' /proc/net/if_inet6
}

OR_PORT_LINE="${OR_PORT}"
case "${OR_IPV6}" in
  0) OR_PORT_LINE="${OR_PORT} IPv4Only" ;;
  auto)
    if ! has_global_ipv6; then
      OR_PORT_LINE="${OR_PORT} IPv4Only"
      log "No global IPv6 address found - ORPort is IPv4 only (set OR_IPV6=1 to force)."
    fi
    ;;
esac

ADDRESS_LINE=""
[ -z "${RELAY_ADDRESS}" ] || ADDRESS_LINE="Address ${RELAY_ADDRESS}"

MYFAMILY_LINE=""
[ -z "${MYFAMILY}" ] || MYFAMILY_LINE="MyFamily ${MYFAMILY}"

BANDWIDTH_LINES=""
[ -z "${BANDWIDTH_RATE}" ] || BANDWIDTH_LINES+="RelayBandwidthRate ${BANDWIDTH_RATE}"$'\n'
[ -z "${BANDWIDTH_BURST}" ] || BANDWIDTH_LINES+="RelayBandwidthBurst ${BANDWIDTH_BURST}"$'\n'
[ -z "${MAX_ADVERTISED_BANDWIDTH}" ] || BANDWIDTH_LINES+="MaxAdvertisedBandwidth ${MAX_ADVERTISED_BANDWIDTH}"$'\n'

ACCOUNTING_LINES=""
if [ -n "${ACCOUNTING_MAX}" ]; then
  ACCOUNTING_LINES="AccountingMax ${ACCOUNTING_MAX}"$'\n'"AccountingStart ${ACCOUNTING_START}"
fi

CONTROL_LINES=""
if [ "${DASHBOARD_ENABLED}" = 1 ]; then
  CONTROL_LINES="ControlSocket unix:${CONTROL_DIR}/control GroupWritable RelaxDirModeCheck
CookieAuthentication 1
CookieAuthFile ${CONTROL_DIR}/control.authcookie
CookieAuthFileGroupReadable 1"
fi

export NICKNAME CONTACT_LINE OR_PORT_LINE ADDRESS_LINE DIR_CACHE BANDWIDTH_LINES \
       ACCOUNTING_LINES MYFAMILY_LINE CONTROL_LINES SANDBOX

# ============================================================
# Render torrc
# ============================================================
# Only the listed variables are substituted, nothing else from the
# environment can leak into the config.
envsubst '${NICKNAME} ${CONTACT_LINE} ${OR_PORT_LINE} ${ADDRESS_LINE} ${DIR_CACHE}
          ${BANDWIDTH_LINES} ${ACCOUNTING_LINES} ${MYFAMILY_LINE} ${CONTROL_LINES}
          ${SANDBOX}' \
  < /etc/tor-template/torrc.template \
  | sed '/^[[:space:]]*$/d' > /etc/tor/torrc
# Empty defaults file, so no distro default can sneak in.
echo "# intentionally empty - see /etc/tor/torrc" > /etc/tor/torrc-defaults

echo "[entrypoint] Rendered torrc:"
echo "-----------------------------------------------------"
grep -v '^##' /etc/tor/torrc
echo "-----------------------------------------------------"

# The "no exit" options are also given on the command line. Command line
# options override the torrc, and for ExitPolicy they REPLACE the whole
# list, so even a tampered torrc cannot turn this relay into an exit.
TOR_ARGS=(
  --defaults-torrc /etc/tor/torrc-defaults
  -f /etc/tor/torrc
  --SocksPort 0
  --ExitRelay 0
  --ExitPolicy "reject *:*"
  --IPv6Exit 0
  --BridgeRelay 0
)

# ============================================================
# Prepare directories (root, before dropping privileges)
# ============================================================
# chmod before chown: once root no longer owns a directory it cannot
# change its mode without CAP_FOWNER, which is dropped.
prepare_dir() {  # dir owner mode
  local dir="$1" owner="$2" mode="$3"
  mkdir -p "${dir}" 2>/dev/null || return 1
  if [ "$(stat -c %U "${dir}")" != "${owner}" ]; then
    chmod "${mode}" "${dir}" 2>/dev/null || true
    chown -R "${owner}:${owner}" "${dir}" 2>/dev/null || return 1
  fi
}

prepare_dir /var/lib/tor debian-tor 700 \
  || die "cannot hand /var/lib/tor to debian-tor (is CAP_CHOWN missing?)"
if [ "${DASHBOARD_ENABLED}" = 1 ]; then
  prepare_dir "${CONTROL_DIR}" debian-tor 750 \
    || die "cannot prepare ${CONTROL_DIR} (mount a tmpfs there when running read-only)"
  # Remove a stale socket/cookie from a previous run (done as debian-tor,
  # root has no DAC override inside the container).
  gosu debian-tor rm -f "${CONTROL_DIR}/control" "${CONTROL_DIR}/control.authcookie"
  if ! prepare_dir "${DASHBOARD_DATA}" tordash 700; then
    log "WARNING: ${DASHBOARD_DATA} is not writable - dashboard statistics are not persisted."
  fi
fi

# ============================================================
# Verify: refuse to start unless Tor itself confirms "no exit"
# ============================================================
gosu debian-tor tor "${TOR_ARGS[@]}" --verify-config >/dev/null \
  || { gosu debian-tor tor "${TOR_ARGS[@]}" --verify-config || true; die "Tor rejected the configuration"; }

EFFECTIVE="$(gosu debian-tor tor "${TOR_ARGS[@]}" --dump-config full 2>/dev/null)"

expect_option() {  # option expected-value
  local actual
  actual="$(printf '%s\n' "${EFFECTIVE}" | awk -v k="$1" 'tolower($1) == tolower(k) { $1=""; sub(/^ /, ""); print }')"
  [ "${actual}" = "$2" ] || die "SAFETY CHECK FAILED: $1 is '${actual//$'\n'/ | }', expected '$2'. Refusing to start."
}
expect_option ExitRelay 0
expect_option ExitPolicy 'reject *:*'
expect_option IPv6Exit 0
expect_option BridgeRelay 0
expect_option SocksPort 0
expect_option ReducedExitPolicy 0
log "Safety check passed: ExitRelay 0, ExitPolicy 'reject *:*', IPv6Exit 0, BridgeRelay 0, SocksPort 0."

log "$(tor --version | head -1)"

if [ "${MODE}" = check ]; then
  log "Config check OK."
  exit 0
fi

# ============================================================
# Start
# ============================================================
if [ "${DASHBOARD_ENABLED}" = 1 ]; then
  log "Starting dashboard on port ${DASHBOARD_PORT} (password: $([ -n "${DASHBOARD_PASSWORD}" ] && echo set || echo none))"
  # The restart loop itself runs as tordash, so no root process stays
  # behind once Tor has been exec'd.
  DASHBOARD_PORT="${DASHBOARD_PORT}" DASHBOARD_PASSWORD="${DASHBOARD_PASSWORD}" \
  OR_PORT="${OR_PORT}" CONTROL_SOCKET="${CONTROL_DIR}/control" DASHBOARD_DATA="${DASHBOARD_DATA}" \
    gosu tordash sh -c 'while true; do
        python3 -u /opt/dashboard/server.py
        echo "[dashboard] exited, restarting in 5s"
        sleep 5
      done' &
fi
unset DASHBOARD_PASSWORD

log "Starting Tor middle relay '${NICKNAME}' on port ${OR_PORT} ..."
exec gosu debian-tor tor "${TOR_ARGS[@]}"
