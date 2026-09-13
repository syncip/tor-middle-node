#!/bin/bash
set -euo pipefail

# ============================================================
# Konfigurierbare Umgebungsvariablen (mit sinnvollen Defaults)
# ============================================================
: "${NICKNAME:?NICKNAME muss gesetzt sein, z.B. -e NICKNAME=MeinMiddleRelay}"
: "${CONTACT_INFO:=noch nicht gesetzt <bitte@example.com>}"
: "${OR_PORT:=9001}"
: "${RELAY_ADDRESS:=}"                 # leer lassen = Tor erkennt die IP selbst
: "${DIR_CACHE:=1}"
: "${MYFAMILY:=}"

# Tor-internes (symmetrisches) Limit - Default = der niedrigere der beiden
# vom Nutzer gewuenschten Werte (Upload), s. torrc.template fuer Begruendung
: "${BANDWIDTH_RATE:=1 MBytes}"
: "${BANDWIDTH_BURST:=2 MBytes}"
: "${MAX_ADVERTISED_BANDWIDTH:=1 MBytes}"

# Optionales Datenvolumen-Limit (leer = kein Limit)
: "${ACCOUNTING_MAX:=}"
: "${ACCOUNTING_START:=}"              # z.B. "month 1 00:00"

# Echtes asymmetrisches Shaping via tc (Linux traffic control)
: "${ENABLE_TC_SHAPING:=false}"
: "${IFACE:=eth0}"
: "${DOWNLOAD_LIMIT_MBIT:=40}"         # 5 MB/s ~= 40 Mbit/s
: "${UPLOAD_LIMIT_MBIT:=8}"            # 1 MB/s ~= 8 Mbit/s

export NICKNAME CONTACT_INFO OR_PORT DIR_CACHE
export BANDWIDTH_RATE BANDWIDTH_BURST MAX_ADVERTISED_BANDWIDTH

# --- Optionale Zeilen zusammenbauen ---------------------------------
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

ACCOUNTING_LINES=""
if [ -n "${ACCOUNTING_MAX}" ]; then
  ACCOUNTING_LINES="AccountingMax ${ACCOUNTING_MAX}"
  if [ -n "${ACCOUNTING_START}" ]; then
    ACCOUNTING_LINES="${ACCOUNTING_LINES}
AccountingStart ${ACCOUNTING_START}"
  fi
fi
export ACCOUNTING_LINES

# --- torrc aus Template rendern -------------------------------------
envsubst < /etc/tor/torrc.template > /etc/tor/torrc
# leere Zeilen von nicht gesetzten optionalen Platzhaltern aufraeumen
sed -i '/^[[:space:]]*$/d' /etc/tor/torrc

echo "[entrypoint] Gerenderte torrc:"
echo "-----------------------------------------------------"
cat /etc/tor/torrc
echo "-----------------------------------------------------"

# --- Optionales tc-basiertes Bandbreiten-Shaping ---------------------
# Tor selbst kann Down-/Upload nicht getrennt begrenzen. Wer echte
# asymmetrische Limits will, braucht das hier - Container dafuer mit
# --cap-add=NET_ADMIN starten. Funktioniert nicht in jeder Umgebung
# (z.B. manche Cloud-Overlay-Netzwerke, Docker Desktop unter Mac/Windows).
if [ "${ENABLE_TC_SHAPING}" = "true" ]; then
  if ! command -v tc >/dev/null 2>&1; then
    echo "[entrypoint] WARNUNG: tc nicht verfuegbar, ueberspringe Shaping." >&2
  else
    echo "[entrypoint] Richte tc-Shaping ein: ${DOWNLOAD_LIMIT_MBIT}mbit down / ${UPLOAD_LIMIT_MBIT}mbit up auf ${IFACE}"

    # Upload (Egress) begrenzen - einfache TBF-Queue auf dem echten Interface
    tc qdisc del dev "${IFACE}" root 2>/dev/null || true
    tc qdisc add dev "${IFACE}" root tbf \
        rate "${UPLOAD_LIMIT_MBIT}mbit" burst 32kbit latency 400ms \
      || echo "[entrypoint] WARNUNG: Upload-Shaping fehlgeschlagen (fehlt NET_ADMIN?)" >&2

    # Download (Ingress) begrenzen - braucht ein IFB-Device, da Linux
    # eingehenden Traffic nicht direkt per tbf drosseln kann
    if modprobe ifb numifbs=1 2>/dev/null; then
      ip link add ifb0 type ifb 2>/dev/null || true
      ip link set ifb0 up

      tc qdisc del dev "${IFACE}" ingress 2>/dev/null || true
      tc qdisc add dev "${IFACE}" ingress
      tc filter add dev "${IFACE}" parent ffff: protocol ip u32 \
          match u32 0 0 action mirred egress redirect dev ifb0

      tc qdisc del dev ifb0 root 2>/dev/null || true
      tc qdisc add dev ifb0 root tbf \
          rate "${DOWNLOAD_LIMIT_MBIT}mbit" burst 32kbit latency 400ms
    else
      echo "[entrypoint] WARNUNG: ifb-Kernelmodul nicht ladbar - Download wird" >&2
      echo "[entrypoint]          NICHT separat begrenzt, nur Tors RelayBandwidthRate greift." >&2
    fi
  fi
else
  echo "[entrypoint] tc-Shaping deaktiviert (ENABLE_TC_SHAPING=false)."
  echo "[entrypoint] Es gilt nur Tors eigenes, symmetrisches RelayBandwidthRate=${BANDWIDTH_RATE}."
fi

echo "[entrypoint] Starte Tor als Middle-Relay '${NICKNAME}' auf Port ${OR_PORT} ..."
exec gosu debian-tor tor -f /etc/tor/torrc
