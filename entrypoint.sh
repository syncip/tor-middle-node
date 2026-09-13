#!/bin/bash
set -euo pipefail

# ============================================================
# Environment variables (see README.md / .env.example)
# ============================================================
: "${NICKNAME:?NICKNAME must be set, e.g. -e NICKNAME=MyMiddleRelay}"
: "${CONTACT_INFO:=not set <please@example.com>}"
: "${OR_PORT:=9001}"
: "${RELAY_ADDRESS:=}"     # leave empty to let Tor auto-detect the public IP
: "${DIR_CACHE:=1}"
: "${MYFAMILY:=}"

# Optional bandwidth cap. Leave empty for no cap (Tor's default).
# Format: "<number> <KBytes|MBytes>". Tor applies one rate to BOTH
# directions - there is no separate download/upload limit.
: "${BANDWIDTH_RATE:=}"
: "${BANDWIDTH_BURST:=}"
: "${MAX_ADVERTISED_BANDWIDTH:=}"

# Optional total data volume cap
: "${ACCOUNTING_MAX:=}"
: "${ACCOUNTING_START:=month 1 00:00}"

export NICKNAME CONTACT_INFO OR_PORT DIR_CACHE

# --- Build optional config blocks --------------------------------------
if [ -n "${RELAY_ADDRESS}" ]; then
  ADDRESS_LINE="Address ${RELAY_ADDRESS}"
else
  ADDRESS_LINE=""
fi
export ADDRESS_LINE

if [ -n "${MYFAMILY}" ]; then
  MYFAMILY_LINE="MyFamily ${MYFAMILY}"
else
  MYFAMILY_LINE=""
fi
export MYFAMILY_LINE

BANDWIDTH_LINES=""
if [ -n "${BANDWIDTH_RATE}" ]; then
  BANDWIDTH_LINES="RelayBandwidthRate ${BANDWIDTH_RATE}"
  [ -n "${BANDWIDTH_BURST}" ] && BANDWIDTH_LINES="${BANDWIDTH_LINES}
RelayBandwidthBurst ${BANDWIDTH_BURST}"
  [ -n "${MAX_ADVERTISED_BANDWIDTH}" ] && BANDWIDTH_LINES="${BANDWIDTH_LINES}
MaxAdvertisedBandwidth ${MAX_ADVERTISED_BANDWIDTH}"
fi
export BANDWIDTH_LINES

ACCOUNTING_LINES=""
if [ -n "${ACCOUNTING_MAX}" ]; then
  ACCOUNTING_LINES="AccountingMax ${ACCOUNTING_MAX}
AccountingStart ${ACCOUNTING_START}"
fi
export ACCOUNTING_LINES

# --- Render torrc -------------------------------------------------------
envsubst < /etc/tor-template/torrc.template > /etc/tor/torrc
sed -i '/^[[:space:]]*$/d' /etc/tor/torrc

echo "[entrypoint] Rendered torrc:"
echo "-----------------------------------------------------"
cat /etc/tor/torrc
echo "-----------------------------------------------------"

echo "[entrypoint] Starting Tor middle relay '${NICKNAME}' on port ${OR_PORT} ..."
exec gosu debian-tor tor -f /etc/tor/torrc
