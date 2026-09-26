"use strict";

// ------------------------------------------------------------------
// Formatting
// ------------------------------------------------------------------
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
function fmtBytes(n) {
  n = Number(n) || 0;
  let i = 0;
  while (Math.abs(n) >= 1000 && i < UNITS.length - 1) { n /= 1000; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)) + " " + UNITS[i];
}
function fmtRate(bytesPerSec) {
  const bits = (Number(bytesPerSec) || 0) * 8;
  const u = ["bit/s", "kbit/s", "Mbit/s", "Gbit/s"];
  let n = bits, i = 0;
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)) + " " + u[i];
}
function fmtDuration(s) {
  s = Math.max(0, Math.floor(s || 0));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d) return `${d} T ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}
const two = (n) => String(n).padStart(2, "0");
const fmtTime = (ts) => { const d = new Date(ts * 1000); return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`; };
const fmtHM = (ts) => { const d = new Date(ts * 1000); return `${two(d.getHours())}:${two(d.getMinutes())}`; };
const fmtDate = (ts) => new Date(ts * 1000).toLocaleString("de-DE");

function el(tag, attrs, text) {
  const e = document.createElementNS(tag === "svg" || attrs?.svg ? "http://www.w3.org/2000/svg" : "http://www.w3.org/1999/xhtml", tag);
  for (const [k, v] of Object.entries(attrs || {})) if (k !== "svg") e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}
const S = (tag, attrs, text) => el(tag, { ...attrs, svg: true }, text);
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------
// Tooltip
// ------------------------------------------------------------------
const tip = $("tooltip");
function showTip(x, y, title, rows) {
  tip.replaceChildren();
  tip.appendChild(el("div", { class: "t" }, title));
  for (const r of rows) {
    const row = el("div", { class: "row" });
    row.appendChild(el("span", { class: "key " + r.cls }));
    row.appendChild(el("span", {}, r.name));
    row.appendChild(el("b", {}, r.value));
    tip.appendChild(row);
  }
  tip.hidden = false;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + w > window.innerWidth - 8) left = x - w - 14;
  if (top + h > window.innerHeight - 8) top = y - h - 14;
  tip.style.left = Math.max(8, left) + "px";
  tip.style.top = Math.max(8, top) + "px";
}
const hideTip = () => { tip.hidden = true; };

// ------------------------------------------------------------------
// Charts (plain SVG)
// ------------------------------------------------------------------
const SERIES = [
  { key: 1, name: "Empfangen", cls: "key-read", color: "var(--read)" },
  { key: 2, name: "Gesendet", cls: "key-written", color: "var(--written)" },
];
const PAD = { l: 64, r: 12, t: 10, b: 24 };

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function yAxis(svg, w, h, max, fmt) {
  for (let i = 0; i <= 4; i++) {
    const y = PAD.t + (h - PAD.t - PAD.b) * (1 - i / 4);
    svg.appendChild(S("line", { class: i === 0 ? "baseline" : "gridline", x1: PAD.l, x2: w - PAD.r, y1: y, y2: y }));
    svg.appendChild(S("text", { class: "tick", x: PAD.l - 8, y: y + 4, "text-anchor": "end" }, fmt(max * i / 4)));
  }
}

// points: [[ts, v1, v2], ...]; fmtY formats values; fmtX formats ticks/tooltips
function lineChart(container, points, opts) {
  const w = container.clientWidth, h = container.clientHeight;
  const svg = S("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": opts.label });
  container.replaceChildren(svg);
  if (points.length < 2) {
    svg.appendChild(S("text", { class: "empty", x: w / 2, y: h / 2, "text-anchor": "middle" }, "Noch keine Daten – sammle…"));
    return;
  }
  const x0 = opts.xMin ?? points[0][0], x1 = opts.xMax ?? points[points.length - 1][0];
  const max = niceMax(Math.max(...points.map((p) => Math.max(p[1], p[2]))));
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  const X = (t) => PAD.l + (x1 === x0 ? 0 : (t - x0) / (x1 - x0)) * iw;
  const Y = (v) => PAD.t + ih * (1 - v / max);

  yAxis(svg, w, h, max, opts.fmtY);
  const ticks = Math.max(2, Math.min(6, Math.floor(iw / 110)));
  for (let i = 0; i <= ticks; i++) {
    const t = x0 + (x1 - x0) * i / ticks;
    svg.appendChild(S("text", { class: "tick", x: X(t), y: h - 6, "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle" }, opts.fmtX(t)));
  }

  // Gaps (e.g. Tor restarts) break the line instead of drawing a bridge.
  const gap = opts.gap;
  for (const s of SERIES) {
    let d = "", area = "", start = null, prev = null;
    const flush = () => {
      if (start !== null && prev !== null) area += `L${X(prev)},${Y(0)}L${X(start)},${Y(0)}Z`;
    };
    for (const p of points) {
      const newSeg = prev === null || p[0] - prev > gap;
      if (newSeg) { flush(); start = p[0]; }
      d += `${newSeg ? "M" : "L"}${X(p[0]).toFixed(1)},${Y(p[s.key]).toFixed(1)}`;
      area += `${newSeg ? "M" + X(p[0]).toFixed(1) + "," + Y(0) + "L" : "L"}${X(p[0]).toFixed(1)},${Y(p[s.key]).toFixed(1)}`;
      prev = p[0];
    }
    flush();
    svg.appendChild(S("path", { class: "area", d: area, fill: s.color }));
    svg.appendChild(S("path", { class: "line", d, stroke: s.color }));
  }

  // Crosshair + tooltip
  const cross = S("line", { class: "crosshair", y1: PAD.t, y2: PAD.t + ih, visibility: "hidden" });
  const markers = SERIES.map((s) => S("circle", { class: "marker", r: 4, fill: s.color, visibility: "hidden" }));
  svg.appendChild(cross);
  markers.forEach((m) => svg.appendChild(m));
  const hit = S("rect", { x: PAD.l, y: PAD.t, width: iw, height: ih, fill: "transparent" });
  svg.appendChild(hit);
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const t = x0 + ((ev.clientX - r.left) * (w / r.width) - PAD.l) / iw * (x1 - x0);
    let best = points[0];
    for (const p of points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    const x = X(best[0]);
    cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
    SERIES.forEach((s, i) => {
      markers[i].setAttribute("cx", x); markers[i].setAttribute("cy", Y(best[s.key]));
      markers[i].setAttribute("visibility", "visible");
    });
    showTip(ev.clientX, ev.clientY, opts.fmtTip(best[0]),
      SERIES.map((s) => ({ cls: s.cls, name: s.name, value: opts.fmtY(best[s.key]) })));
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerleave", () => {
    hideTip(); cross.setAttribute("visibility", "hidden");
    markers.forEach((m) => m.setAttribute("visibility", "hidden"));
  });
}

// days: [["YYYY-MM-DD", [read, written]], ...]
function barChart(container, days) {
  const w = container.clientWidth, h = container.clientHeight;
  const svg = S("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": "Traffic pro Tag" });
  container.replaceChildren(svg);
  if (!days.length) {
    svg.appendChild(S("text", { class: "empty", x: w / 2, y: h / 2, "text-anchor": "middle" }, "Noch keine Daten"));
    return;
  }
  const max = niceMax(Math.max(...days.map((d) => Math.max(d[1][0], d[1][1]))));
  const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
  yAxis(svg, w, h, max, fmtBytes);
  const slots = Math.max(days.length, 7);
  const slot = iw / slots;
  const bw = Math.max(2, Math.min(18, (slot - 6) / 2));
  const every = Math.ceil(days.length / Math.max(1, Math.floor(iw / 70)));
  days.forEach(([day, v], i) => {
    const cx = PAD.l + slot * (i + 0.5);
    const g = S("g", { class: "bar", tabindex: 0 });
    SERIES.forEach((s, j) => {
      const val = v[j], bh = Math.max(val > 0 ? 1 : 0, ih * val / max);
      const x = cx + (j === 0 ? -bw - 1 : 1);   // 2px gap between the pair
      const y = PAD.t + ih - bh, r = Math.min(4, bw / 2, bh);
      // rounded top, square at the baseline
      g.appendChild(S("path", {
        fill: s.color,
        d: `M${x},${PAD.t + ih}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${PAD.t + ih}Z`,
      }));
    });
    g.appendChild(S("rect", { x: cx - slot / 2, y: PAD.t, width: slot, height: ih, fill: "transparent" }));
    const label = new Date(day + "T00:00:00Z").toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", timeZone: "UTC" });
    const show = (ev) => {
      const r = ev.target.getBoundingClientRect ? ev.target.getBoundingClientRect() : { left: 0, top: 0 };
      showTip(ev.clientX ?? r.left, ev.clientY ?? r.top, label + " (UTC)",
        SERIES.map((s, j) => ({ cls: s.cls, name: s.name, value: fmtBytes(v[j]) })));
    };
    g.addEventListener("pointermove", show);
    g.addEventListener("focus", show);
    g.addEventListener("pointerleave", hideTip);
    g.addEventListener("blur", hideTip);
    svg.appendChild(g);
    if (i % every === 0) svg.appendChild(S("text", { class: "tick", x: cx, y: h - 6, "text-anchor": "middle" }, label));
  });
}

// ------------------------------------------------------------------
// Data
// ------------------------------------------------------------------
let live = [];
let lastLiveTs = 0;
let status = null;
let history = [];

async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

function setBadge(id, cls, text) {
  const b = $(id);
  b.className = "badge " + cls;
  b.querySelector(".lbl").textContent = text;
}

function fillTable(id, rows) {
  const tb = $(id).querySelector("tbody");
  tb.replaceChildren();
  for (const [k, v, cls] of rows) {
    const tr = el("tr");
    tr.appendChild(el("th", {}, k));
    tr.appendChild(el("td", cls ? { class: cls } : {}, v === undefined || v === null || v === "" ? "–" : String(v)));
    tb.appendChild(tr);
  }
}

function renderLive() {
  const now = Math.floor(Date.now() / 1000);
  lineChart($("chart-live"), live, {
    label: "Live-Traffic", xMin: now - 600, xMax: now, gap: 5,
    fmtY: fmtRate, fmtX: fmtHM, fmtTip: fmtTime,
  });
  const recent = live.slice(-10);
  const avg = (k) => recent.reduce((a, p) => a + p[k], 0) / Math.max(1, recent.length);
  $("live-read").textContent = recent.length ? fmtRate(avg(1)) : "–";
  $("live-written").textContent = recent.length ? fmtRate(avg(2)) : "–";
}

function renderHistory() {
  const now = Math.floor(Date.now() / 1000);
  lineChart($("chart-day"), history, {
    label: "Traffic 24 Stunden", xMin: now - 86400, xMax: now, gap: 180,
    fmtY: fmtRate, fmtX: fmtHM, fmtTip: (t) => fmtDate(t),
  });
}

function renderStatus() {
  const s = status;
  if (!s) return;
  const st = s.stats || {};
  const tor = s.tor || {};

  if (!s.connected) {
    setBadge("badge-conn", "warn", "Tor nicht erreichbar");
  } else if ((tor.bootstrap || "").includes("PROGRESS=100")) {
    setBadge("badge-conn", "good", "Online · " + fmtDuration(tor.uptime));
  } else {
    setBadge("badge-conn", "warn", "Startet…");
  }

  const safety = s.safety;
  const alert = $("alert");
  if (safety && safety.ok) {
    setBadge("badge-exit", "good", "Kein Exit · reject *:*");
    alert.hidden = true;
  } else if (safety) {
    setBadge("badge-exit", "bad", "EXIT-KONFIGURATION ERKANNT");
    alert.hidden = false;
    alert.textContent = "Achtung: Tor meldete eine Exit-Konfiguration. Das Dashboard hat Tor sofort gestoppt. " + (safety.problems || []).join("; ");
  }

  const set = s.settings || {};
  if (set.Nickname) { $("nickname").textContent = set.Nickname; document.title = set.Nickname + " · Tor Middle Relay"; }
  $("fingerprint").textContent = tor.fingerprint ? "Fingerprint " + tor.fingerprint.replace(/(.{4})/g, "$1 ").trim() : (s.error ? "Fehler: " + s.error : "–");

  const pair = (v) => v ? `↓ ${fmtBytes(v[0])} · ↑ ${fmtBytes(v[1])}` : "–";
  const sum = (v) => v ? fmtBytes(v[0] + v[1]) : "–";
  $("t-today").textContent = sum(st.today); $("t-today-s").textContent = pair(st.today);
  $("t-month").textContent = sum(st.month); $("t-month-s").textContent = pair(st.month);
  $("t-total").textContent = sum(st.total);
  $("t-total-s").textContent = st.since ? "seit " + new Date(st.since * 1000).toLocaleDateString("de-DE") + (st.persisted ? "" : " (nicht gespeichert)") : "–";

  const c = s.connections || {};
  const orc = c.tor_or_connections || {};
  const connected = orc.CONNECTED || 0;
  $("c-total").textContent = s.connected ? String(connected) : "–";
  $("c-split").textContent = s.connected ? `TCP: ${c.tcp_inbound} ein · ${c.tcp_outbound} aus` : "–";

  const tr = s.traffic || {};
  fillTable("relay-table", [
    ["Status", s.connected ? (tor.liveness === "up" ? "Netzwerk erreichbar" : tor.liveness) : "nicht verbunden"],
    ["Tor-Version", tor.version],
    ["Laufzeit", tor.uptime ? fmtDuration(tor.uptime) : null],
    ["Erkannte Adresse", tor.address],
    ["ORPort erreichbar (Selbsttest)", tor.reachable_or === "1" ? "ja" : tor.reachable_or === "0" ? "noch nicht / nein" : null],
    ["Im Konsens", tor.in_consensus ? "ja" : "noch nicht (dauert einige Stunden)"],
    ["Flags", (tor.flags || []).join(", ")],
    ["Konsens-Bandbreite", tor.consensus_bandwidth ? tor.consensus_bandwidth + " (Einheit ~ KB/s)" : null],
    ["Seit Tor-Start empfangen", fmtBytes(tr.read_since_start)],
    ["Seit Tor-Start gesendet", fmtBytes(tr.written_since_start)],
  ]);

  const connRows = [
    ["Tor-Verbindungen (verbunden)", connected],
    ["TCP eingehend (ORPort)", c.tcp_inbound],
    ["TCP ausgehend", c.tcp_outbound],
  ];
  for (const [k, v] of Object.entries(orc)) if (k !== "CONNECTED") connRows.push([`Tor-Verbindungen (${k})`, v]);
  if (s.accounting) {
    const a = s.accounting;
    const b = (a.bytes || "").split(" ").map(Number), left = (a["bytes-left"] || "").split(" ").map(Number);
    connRows.push(["Accounting verbraucht", b.length === 2 ? `↓ ${fmtBytes(b[0])} · ↑ ${fmtBytes(b[1])}` : null]);
    connRows.push(["Accounting verbleibend", left.length === 2 ? `↓ ${fmtBytes(left[0])} · ↑ ${fmtBytes(left[1])}` : null]);
    connRows.push(["Accounting-Zeitraum endet", a["interval-end"]]);
    connRows.push(["Ruhemodus", a.hibernating]);
  }
  fillTable("conn-table", connRows);

  // Tor reports bandwidth options in bytes/s; 0 and the 1 GB default mean "no limit".
  const bw = (v) => v === undefined ? null : (v === "0" || v === "1073741824") ? "unbegrenzt" : fmtBytes(v) + "/s";
  const flag = (k, good) => [k, set[k], set[k] === good ? "ok" : "bad"];
  fillTable("settings-table", [
    flag("ExitRelay", "0"),
    ["ExitPolicy", set.ExitPolicy, set.ExitPolicy === "reject *:*" ? "ok" : "bad"],
    ["Effektive Exit-Policy",
      !safety ? null : !safety.ok ? "EXIT ERKANNT" : safety.exit_policy ? safety.exit_policy.join(", ") : "Deskriptor wird noch erstellt",
      safety && safety.ok ? "ok" : "bad"],
    flag("IPv6Exit", "0"),
    flag("BridgeRelay", "0"),
    flag("SocksPort", "0"),
    ["Nickname", set.Nickname],
    ["ContactInfo", set.ContactInfo],
    ["ORPort", set.ORPort],
    ["Address", set.Address || "automatisch"],
    ["DirCache", set.DirCache],
    ["RelayBandwidthRate", bw(set.RelayBandwidthRate)],
    ["RelayBandwidthBurst", bw(set.RelayBandwidthBurst)],
    ["MaxAdvertisedBandwidth", bw(set.MaxAdvertisedBandwidth)],
    ["AccountingMax", set.AccountingMax === "0" ? "kein Limit" : set.AccountingMax ? fmtBytes(set.AccountingMax) : null],
    ["AccountingStart", set.AccountingMax === "0" ? "–" : set.AccountingStart],
    ["MyFamily", set.MyFamily],
    ["Sandbox", set.Sandbox],
  ]);

  const tbody = $("days-table").querySelector("tbody");
  tbody.replaceChildren();
  for (const [day, v] of (st.days || []).slice().reverse()) {
    const row = el("tr");
    row.appendChild(el("td", {}, day));
    row.appendChild(el("td", {}, fmtBytes(v[0])));
    row.appendChild(el("td", {}, fmtBytes(v[1])));
    tbody.appendChild(row);
  }
  barChart($("chart-days"), st.days || []);

  $("footer").textContent = s.updated ? "Aktualisiert " + fmtDate(s.updated) : "";
}

async function pollLive() {
  try {
    const d = await getJSON("api/live?since=" + lastLiveTs);
    if (d.live.length) {
      live = live.concat(d.live).filter((p) => p[0] > d.now - 600);
      lastLiveTs = live[live.length - 1][0];
    }
    renderLive();
  } catch (e) { /* keep last state */ }
}
async function pollStatus() {
  try { status = await getJSON("api/status"); renderStatus(); }
  catch (e) { setBadge("badge-conn", "warn", "Dashboard nicht erreichbar"); }
}
async function pollHistory() {
  try { history = (await getJSON("api/history")).minutes; renderHistory(); } catch (e) { /* ignore */ }
}

pollLive(); pollStatus(); pollHistory();
setInterval(pollLive, 2000);
setInterval(pollStatus, 5000);
setInterval(pollHistory, 60000);
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { renderLive(); renderHistory(); renderStatus(); }, 150);
});
