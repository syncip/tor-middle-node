"use strict";

// ==================================================================
// Formatting
// ==================================================================
const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];
function fmtBytes(n) {
  n = Number(n) || 0;
  let i = 0;
  while (Math.abs(n) >= 1000 && i < UNITS.length - 1) { n /= 1000; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)) + " " + UNITS[i];
}
function fmtRate(bytesPerSec) {
  let n = (Number(bytesPerSec) || 0) * 8, i = 0;
  const u = ["bit/s", "kbit/s", "Mbit/s", "Gbit/s"];
  while (n >= 1000 && i < u.length - 1) { n /= 1000; i++; }
  return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)) + " " + u[i];
}
function fmtDuration(s) {
  s = Math.max(0, Math.round(s || 0));
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60;
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  if (m) return `${m} min${sec ? " " + sec + " s" : ""}`;
  return `${sec} s`;
}
const LOCALE = "en-GB";
const fmtClock = (ts) => new Date(ts * 1000).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtHM = (ts) => new Date(ts * 1000).toLocaleTimeString(LOCALE, { hour: "2-digit", minute: "2-digit" });
const fmtDay = (ts) => new Date(ts * 1000).toLocaleDateString(LOCALE, { day: "numeric", month: "short" });
const fmtDayHM = (ts) => fmtDay(ts) + " " + fmtHM(ts);
const fmtFull = (ts) => new Date(ts * 1000).toLocaleString(LOCALE, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtDate = (ts) => new Date(ts * 1000).toLocaleDateString(LOCALE, { day: "numeric", month: "short", year: "numeric" });
const dayLabel = (day) => new Date(day + "T00:00:00Z").toLocaleDateString(LOCALE, { day: "numeric", month: "short", timeZone: "UTC" });

// ==================================================================
// DOM helpers (all text goes through textContent)
// ==================================================================
const SVGNS = "http://www.w3.org/2000/svg";
function el(tag, attrs, text) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}
function S(tag, attrs, text) {
  const e = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
}
const $ = (id) => document.getElementById(id);
const setAttrs = (e, attrs) => { for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); };

// ==================================================================
// Tooltip
// ==================================================================
const tip = $("tooltip");
function showTip(x, y, title, rows) {
  tip.replaceChildren(el("div", { class: "t" }, title));
  for (const r of rows) {
    const row = el("div", { class: "row" });
    if (r.cls) row.appendChild(el("span", { class: "key " + r.cls }));
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

// ==================================================================
// Charts
// ==================================================================
const SERIES = [
  { idx: 1, name: "Received", cls: "key-read", color: "var(--read)" },
  { idx: 2, name: "Sent", cls: "key-written", color: "var(--written)" },
];
const PAD = { l: 64, r: 12, t: 10, b: 24 };

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

function drawYAxis(svg, w, h, max, fmt) {
  for (let i = 0; i <= 4; i++) {
    const y = PAD.t + (h - PAD.t - PAD.b) * (1 - i / 4);
    svg.appendChild(S("line", { class: i === 0 ? "baseline" : "gridline", x1: PAD.l, x2: w - PAD.r, y1: y, y2: y }));
    svg.appendChild(S("text", { class: "tick", x: PAD.l - 8, y: y + 4, "text-anchor": "end" }, fmt(max * i / 4)));
  }
}

// Tick positions on "round" local times (full minutes, hours, midnight).
const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800,
  21600, 43200, 86400, 172800, 604800, 1209600];
function timeTicks(a, b, maxTicks) {
  const step = TICK_STEPS.find((s) => (b - a) / s <= maxTicks) || TICK_STEPS[TICK_STEPS.length - 1];
  const ticks = [];
  for (let local = Math.ceil(a / step) * step - step; local <= b + step; local += step) {
    // Align to local time: shift by this moment's UTC offset.
    const off = step >= 3600 ? -new Date(local * 1000).getTimezoneOffset() * 60 : 0;
    const t = Math.round((local + off) / step) * step - off;
    if (t >= a && t <= b && !ticks.includes(t)) ticks.push(t);
  }
  return ticks;
}

function tickFormatter(span, res) {
  if (span <= 15 * 60 && res < 60) return fmtClock;
  if (span <= 36 * 3600) return fmtHM;
  if (span <= 4 * 86400) return fmtDayHM;
  return fmtDay;
}

// Small panel below a chart that shows totals for the selected range.
function renderSelectionPanel(panel, title, stats, actions) {
  panel.replaceChildren();
  const head = el("div", { class: "sel-head" });
  head.appendChild(el("strong", {}, "Selection"));
  head.appendChild(el("span", { class: "muted" }, title));
  const btns = el("div", { class: "sel-actions" });
  for (const a of actions) {
    const b = el("button", { type: "button", class: "btn small" }, a.label);
    b.addEventListener("click", a.onClick);
    btns.appendChild(b);
  }
  head.appendChild(btns);
  panel.appendChild(head);
  const grid = el("dl", { class: "sel-grid" });
  for (const [label, value, cls] of stats) {
    const item = el("div");
    const dt = el("dt");
    if (cls) dt.appendChild(el("span", { class: "key " + cls }));
    dt.appendChild(document.createTextNode(label));
    item.appendChild(dt);
    item.appendChild(el("dd", {}, value));
    grid.appendChild(item);
  }
  panel.appendChild(grid);
  panel.hidden = false;
}

/**
 * Line chart over time with crosshair tooltip, drag-to-select (shows
 * totals for the range), zoom to selection, Ctrl/pinch wheel zoom,
 * shift/horizontal wheel pan and double-click reset.
 *
 * points: [[ts, receivedRate, sentRate], ...] (bytes/s); res = seconds
 * represented by one point.
 */
class TimeChart {
  constructor(container, panel, opts) {
    this.el = container;
    this.panel = panel;
    this.opts = opts;
    this.points = [];
    this.domain = [0, 1];
    this.view = null;     // [t0, t1] when zoomed
    this.sel = null;      // [t0, t1] selected range
    this.drag = null;
    this.res = opts.res || 1;
    this.el.addEventListener("dblclick", () => this.resetZoom());
    this.el.addEventListener("wheel", (ev) => this.onWheel(ev), { passive: false });
  }

  setData(points, domain, res) {
    this.points = points;
    this.domain = domain;
    if (res) this.res = res;
    if (this.view && (this.view[1] < domain[0] || this.view[0] > domain[1])) this.view = null;
    if (!this.drag) this.render();
    if (this.sel) this.updatePanel();
  }

  range() { return this.view || this.domain; }
  zoomed() { return !!this.view; }

  setView(a, b) {
    const [d0, d1] = this.domain;
    const minSpan = Math.max(this.res * 10, 10);
    if (b - a < minSpan) { const c = (a + b) / 2; a = c - minSpan / 2; b = c + minSpan / 2; }
    a = Math.max(d0, a); b = Math.min(d1, b);
    this.view = (a <= d0 && b >= d1) ? null : [a, b];
    this.render();
    if (this.sel) this.updatePanel();
  }

  resetZoom() { this.view = null; this.render(); if (this.sel) this.updatePanel(); }
  clearSelection() { this.sel = null; this.panel.hidden = true; this.render(); }

  onWheel(ev) {
    const [a, b] = this.range();
    const t = this.timeAt(ev.clientX);
    if (ev.ctrlKey) {                       // Ctrl + wheel, or trackpad pinch
      ev.preventDefault();
      const f = Math.exp(ev.deltaY * 0.01);
      this.setView(t - (t - a) * f, t + (b - t) * f);
    } else if (this.zoomed() && (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY))) {
      ev.preventDefault();
      const dx = (ev.shiftKey ? ev.deltaY : ev.deltaX) / this.iw * (b - a);
      const [d0, d1] = this.domain;
      const shift = Math.max(d0 - a, Math.min(d1 - b, dx));
      this.setView(a + shift, b + shift);
    }
  }

  timeAt(clientX) {
    const r = this.svg.getBoundingClientRect();
    const [a, b] = this.range();
    const x = (clientX - r.left) * (this.w / r.width);
    return a + Math.min(1, Math.max(0, (x - PAD.l) / this.iw)) * (b - a);
  }

  visible() {
    const [a, b] = this.range();
    const pad = this.res;
    return this.points.filter((p) => p[0] >= a - pad && p[0] <= b + pad);
  }

  render() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w) return;
    this.w = w; this.h = h;
    const svg = S("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": this.opts.label });
    this.svg = svg;
    this.el.replaceChildren(svg);
    const iw = this.iw = w - PAD.l - PAD.r, ih = this.ih = h - PAD.t - PAD.b;
    const [a, b] = this.range();
    const pts = this.visible();
    const max = niceMax(Math.max(0, ...pts.map((p) => Math.max(p[1], p[2]))));
    const X = this.X = (t) => PAD.l + (b === a ? 0 : (t - a) / (b - a)) * iw;
    const Y = this.Y = (v) => PAD.t + ih * (1 - v / max);

    drawYAxis(svg, w, h, max, fmtRate);
    const fmtX = tickFormatter(b - a, this.res);
    for (const t of timeTicks(a, b, Math.max(2, Math.min(7, Math.floor(iw / 100))))) {
      const x = X(t);
      const anchor = x < PAD.l + 30 ? "start" : x > PAD.l + iw - 30 ? "end" : "middle";
      svg.appendChild(S("text", { class: "tick", x, y: h - 6, "text-anchor": anchor }, fmtX(t)));
    }

    // Selection band (below the lines)
    this.band = S("rect", { class: "band", y: PAD.t, height: ih, visibility: "hidden" });
    svg.appendChild(this.band);
    this.updateBand();

    if (pts.length < 2) {
      svg.appendChild(S("text", { class: "empty", x: PAD.l + iw / 2, y: PAD.t + ih / 2, "text-anchor": "middle" },
        this.points.length < 2 ? "No data yet – collecting…" : "No data in this range"));
    } else {
      const clip = "clip-" + this.el.id;
      const defs = S("defs");
      const cp = S("clipPath", { id: clip });
      cp.appendChild(S("rect", { x: PAD.l, y: 0, width: iw, height: h }));
      defs.appendChild(cp);
      svg.appendChild(defs);
      const g = S("g", { "clip-path": `url(#${clip})` });
      const gap = this.res * 3 + 2;   // missing samples break the line
      for (const s of SERIES) {
        let line = "", area = "", segStart = null, prev = null;
        const close = () => { if (segStart !== null) area += `L${X(prev).toFixed(1)},${Y(0)}L${X(segStart).toFixed(1)},${Y(0)}Z`; };
        for (const p of pts) {
          const x = X(p[0]).toFixed(1), y = Y(p[s.idx]).toFixed(1);
          if (prev === null || p[0] - prev > gap) {
            close(); segStart = p[0];
            line += `M${x},${y}`; area += `M${x},${Y(0)}L${x},${y}`;
          } else { line += `L${x},${y}`; area += `L${x},${y}`; }
          prev = p[0];
        }
        close();
        g.appendChild(S("path", { class: "area", d: area, fill: s.color }));
        g.appendChild(S("path", { class: "line", d: line, stroke: s.color }));
      }
      svg.appendChild(g);
    }

    // Overlay: crosshair, markers, drag rectangle, hit area
    this.cross = S("line", { class: "crosshair", y1: PAD.t, y2: PAD.t + ih, visibility: "hidden" });
    this.markers = SERIES.map((s) => S("circle", { class: "marker", r: 4, fill: s.color, visibility: "hidden" }));
    this.brush = S("rect", { class: "brush", y: PAD.t, height: ih, visibility: "hidden" });
    svg.append(this.cross, ...this.markers, this.brush);
    const hit = S("rect", { class: "hit", x: PAD.l, y: PAD.t, width: iw, height: ih });
    svg.appendChild(hit);
    hit.addEventListener("pointerdown", (ev) => this.onDown(ev));
    hit.addEventListener("pointermove", (ev) => this.onMove(ev));
    hit.addEventListener("pointerup", (ev) => this.onUp(ev));
    hit.addEventListener("pointercancel", () => { this.drag = null; this.brush.setAttribute("visibility", "hidden"); });
    hit.addEventListener("pointerleave", () => { if (!this.drag) this.hideHover(); });

    if (this.opts.onRender) this.opts.onRender(this);
  }

  updateBand() {
    if (!this.band) return;
    if (!this.sel) { this.band.setAttribute("visibility", "hidden"); return; }
    const [a, b] = this.range();
    const x0 = Math.max(PAD.l, this.X ? this.X(Math.max(a, this.sel[0])) : PAD.l);
    const x1 = Math.min(PAD.l + this.iw, this.X ? this.X(Math.min(b, this.sel[1])) : PAD.l);
    if (x1 <= x0) { this.band.setAttribute("visibility", "hidden"); return; }
    setAttrs(this.band, { x: x0, width: x1 - x0, visibility: "visible" });
  }

  hideHover() {
    hideTip();
    if (!this.cross) return;
    this.cross.setAttribute("visibility", "hidden");
    this.markers.forEach((m) => m.setAttribute("visibility", "hidden"));
  }

  onDown(ev) {
    if (ev.button !== 0) return;
    ev.currentTarget.setPointerCapture(ev.pointerId);
    this.drag = { t0: this.timeAt(ev.clientX), x0: ev.clientX };
    this.hideHover();
  }

  onMove(ev) {
    if (this.drag) {
      const t1 = this.timeAt(ev.clientX);
      const a = Math.min(this.drag.t0, t1), b = Math.max(this.drag.t0, t1);
      setAttrs(this.brush, { x: this.X(a), width: Math.max(1, this.X(b) - this.X(a)), visibility: "visible" });
      return;
    }
    const pts = this.visible();
    if (!pts.length) return;
    const t = this.timeAt(ev.clientX);
    let best = pts[0];
    for (const p of pts) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    const x = this.X(best[0]);
    setAttrs(this.cross, { x1: x, x2: x, visibility: "visible" });
    SERIES.forEach((s, i) => setAttrs(this.markers[i], { cx: x, cy: this.Y(best[s.idx]), visibility: "visible" }));
    const label = this.res >= 3600 ? `${fmtDayHM(best[0])} (1 h average)` : this.res >= 60 ? `${fmtDayHM(best[0])} (1 min average)` : fmtClock(best[0]);
    showTip(ev.clientX, ev.clientY, label, SERIES.map((s) => ({ cls: s.cls, name: s.name, value: fmtRate(best[s.idx]) })));
  }

  onUp(ev) {
    if (!this.drag) return;
    const d = this.drag;
    this.drag = null;
    this.brush.setAttribute("visibility", "hidden");
    if (Math.abs(ev.clientX - d.x0) < 5) {          // a click, not a drag
      if (this.sel) this.clearSelection();
      return;
    }
    const t1 = this.timeAt(ev.clientX);
    this.sel = [Math.min(d.t0, t1), Math.max(d.t0, t1)];
    this.updateBand();
    this.updatePanel();
  }

  // Totals for the selected range, from the points' average rates.
  updatePanel() {
    const [a, b] = this.sel;
    const pts = this.points.filter((p) => p[0] >= a && p[0] <= b);
    const res = this.res;
    let rx = 0, tx = 0, peakR = 0, peakT = 0;
    for (const p of pts) {
      rx += p[1] * res; tx += p[2] * res;
      peakR = Math.max(peakR, p[1]); peakT = Math.max(peakT, p[2]);
    }
    const covered = pts.length * res, span = Math.max(1, b - a);
    const avgR = covered ? rx / covered : 0, avgT = covered ? tx / covered : 0;
    const peakNote = res >= 3600 ? " (1 h avg)" : res >= 60 ? " (1 min avg)" : "";
    const fmt = (b - a) > 86400 ? fmtDayHM : (res < 60 ? fmtClock : fmtHM);
    const title = `${fmt(a)} – ${fmt(b)} · ${fmtDuration(span)}` +
      (covered && covered < span * 0.95 ? ` · data for ${Math.round(Math.min(1, covered / span) * 100)} %` : "");
    const actions = [{ label: "Zoom to selection", onClick: () => this.setView(a, b) }];
    if (this.zoomed()) actions.push({ label: "Reset zoom", onClick: () => this.resetZoom() });
    actions.push({ label: "Clear", onClick: () => this.clearSelection() });
    renderSelectionPanel(this.panel, title, pts.length ? [
      ["Received", fmtBytes(rx), "key-read"],
      ["Sent", fmtBytes(tx), "key-written"],
      ["Total", fmtBytes(rx + tx)],
      ["Avg. receive rate", fmtRate(avgR), "key-read"],
      ["Avg. send rate", fmtRate(avgT), "key-written"],
      ["Peak receive" + peakNote, fmtRate(peakR), "key-read"],
      ["Peak send" + peakNote, fmtRate(peakT), "key-written"],
    ] : [["No data in this range", "–"]], actions);
  }
}

/** Daily bars with drag-to-select (or click a bar) for totals. */
class DayChart {
  constructor(container, panel) {
    this.el = container;
    this.panel = panel;
    this.days = [];
    this.sel = null;     // [i0, i1] indices
    this.drag = null;
  }

  setData(days) {
    const changed = JSON.stringify(days) !== JSON.stringify(this.days);
    if (!changed) return;
    const keys = this.sel ? [this.days[this.sel[0]]?.[0], this.days[this.sel[1]]?.[0]] : null;
    this.days = days;
    if (keys) {
      const i0 = days.findIndex((d) => d[0] === keys[0]), i1 = days.findIndex((d) => d[0] === keys[1]);
      this.sel = i0 >= 0 && i1 >= 0 ? [i0, i1] : null;
    }
    if (!this.drag) this.render();
    if (this.sel) this.updatePanel(); else this.panel.hidden = true;
  }

  indexAt(clientX) {
    const r = this.svg.getBoundingClientRect();
    const x = (clientX - r.left) * (this.w / r.width) - PAD.l;
    return Math.max(0, Math.min(this.days.length - 1, Math.floor(x / this.slot)));
  }

  render() {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w) return;
    this.w = w;
    const svg = S("svg", { viewBox: `0 0 ${w} ${h}`, role: "img", "aria-label": "Traffic per day" });
    this.svg = svg;
    this.el.replaceChildren(svg);
    const days = this.days;
    if (!days.length) {
      svg.appendChild(S("text", { class: "empty", x: w / 2, y: h / 2, "text-anchor": "middle" }, "No data yet"));
      return;
    }
    const iw = w - PAD.l - PAD.r, ih = h - PAD.t - PAD.b;
    const max = niceMax(Math.max(...days.map((d) => Math.max(d[1][0], d[1][1]))));
    drawYAxis(svg, w, h, max, fmtBytes);
    const slot = this.slot = iw / days.length;
    const bw = Math.max(2, Math.min(18, (slot - 6) / 2));
    const every = Math.ceil(days.length / Math.max(1, Math.floor(iw / 70)));
    this.bars = [];
    days.forEach(([day, v], i) => {
      const cx = PAD.l + slot * (i + 0.5);
      const g = S("g", { class: "bar" });
      SERIES.forEach((s, j) => {
        const val = v[j], bh = Math.max(val > 0 ? 1 : 0, ih * val / max);
        const x = cx + (j === 0 ? -bw - 1 : 1);   // 2px gap between the pair
        const y = PAD.t + ih - bh, r = Math.min(4, bw / 2, bh);
        g.appendChild(S("path", {
          fill: s.color,
          d: `M${x},${PAD.t + ih}V${y + r}Q${x},${y} ${x + r},${y}H${x + bw - r}Q${x + bw},${y} ${x + bw},${y + r}V${PAD.t + ih}Z`,
        }));
      });
      svg.appendChild(g);
      this.bars.push(g);
      if (i % every === 0) svg.appendChild(S("text", { class: "tick", x: cx, y: h - 6, "text-anchor": "middle" }, dayLabel(day)));
    });
    this.applySelectionStyle();

    const hit = S("rect", { class: "hit", x: PAD.l, y: PAD.t, width: iw, height: ih });
    svg.appendChild(hit);
    hit.addEventListener("pointerdown", (ev) => {
      if (ev.button !== 0) return;
      hit.setPointerCapture(ev.pointerId);
      this.drag = { i0: this.indexAt(ev.clientX) };
      hideTip();
    });
    hit.addEventListener("pointermove", (ev) => {
      const i = this.indexAt(ev.clientX);
      if (this.drag) {
        this.sel = [Math.min(this.drag.i0, i), Math.max(this.drag.i0, i)];
        this.applySelectionStyle();
        return;
      }
      const [day, v] = days[i];
      showTip(ev.clientX, ev.clientY, dayLabel(day) + " (UTC)",
        SERIES.map((s, j) => ({ cls: s.cls, name: s.name, value: fmtBytes(v[j]) })));
    });
    hit.addEventListener("pointerup", (ev) => {
      if (!this.drag) return;
      const i = this.indexAt(ev.clientX);
      const single = i === this.drag.i0;
      const wasOnly = this.sel && this.sel[0] === i && this.sel[1] === i;
      this.sel = single && wasOnly ? null : [Math.min(this.drag.i0, i), Math.max(this.drag.i0, i)];
      this.drag = null;
      this.applySelectionStyle();
      if (this.sel) this.updatePanel(); else this.panel.hidden = true;
    });
    hit.addEventListener("pointerleave", () => { if (!this.drag) hideTip(); });
  }

  applySelectionStyle() {
    (this.bars || []).forEach((g, i) => {
      g.classList.toggle("dim", !!this.sel && (i < this.sel[0] || i > this.sel[1]));
    });
  }

  updatePanel() {
    const [i0, i1] = this.sel;
    const sel = this.days.slice(i0, i1 + 1);
    const rx = sel.reduce((s, d) => s + d[1][0], 0), tx = sel.reduce((s, d) => s + d[1][1], 0);
    const busiest = sel.reduce((m, d) => (d[1][0] + d[1][1] > m[1][0] + m[1][1] ? d : m), sel[0]);
    const title = sel.length === 1 ? dayLabel(sel[0][0]) : `${dayLabel(sel[0][0])} – ${dayLabel(sel[sel.length - 1][0])} · ${sel.length} days`;
    const stats = [
      ["Received", fmtBytes(rx), "key-read"],
      ["Sent", fmtBytes(tx), "key-written"],
      ["Total", fmtBytes(rx + tx)],
    ];
    if (sel.length > 1) {
      stats.push(["Average per day", fmtBytes((rx + tx) / sel.length)]);
      stats.push(["Busiest day", `${dayLabel(busiest[0])} · ${fmtBytes(busiest[1][0] + busiest[1][1])}`]);
    }
    stats.push(["Avg. rate (in / out)", `${fmtRate(rx / (86400 * sel.length))} / ${fmtRate(tx / (86400 * sel.length))}`]);
    renderSelectionPanel(this.panel, title, stats, [{
      label: "Clear", onClick: () => { this.sel = null; this.applySelectionStyle(); this.panel.hidden = true; },
    }]);
  }
}

// ==================================================================
// API
// ==================================================================
async function getJSON(url) {
  const r = await fetch(url, { cache: "no-store", credentials: "same-origin" });
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}

let csrfToken = null;
async function postJSON(url, body) {
  const r = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrfToken || "" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await r.json(); } catch (e) { /* non-JSON error */ }
  if (!r.ok) {
    const err = new Error(data.error || `HTTP ${r.status}`);
    err.fields = data.fields || {};
    throw err;
  }
  return data;
}

// ==================================================================
// Overview
// ==================================================================
let status = null;
let live = [];
let lastLiveTs = 0;
let historyRange = "24h";
const RANGE_SECONDS = { "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400, "90d": 90 * 86400 };

const liveChart = new TimeChart($("chart-live"), $("sel-live"), { label: "Live traffic", res: 1 });
const historyChart = new TimeChart($("chart-history"), $("sel-history"), { label: "Traffic history", res: 60 });
const dayChart = new DayChart($("chart-days"), $("sel-days"));

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
  liveChart.setData(live, [now - 600, now], 1);
  const recent = live.slice(-10);
  const avg = (k) => recent.reduce((a, p) => a + p[k], 0) / Math.max(1, recent.length);
  $("live-read").textContent = recent.length ? fmtRate(avg(1)) : "–";
  $("live-written").textContent = recent.length ? fmtRate(avg(2)) : "–";
}

function renderStatus() {
  const s = status;
  if (!s) return;
  const st = s.stats || {};
  const tor = s.tor || {};

  if (!s.connected) setBadge("badge-conn", "warn", "Tor not reachable");
  else if ((tor.bootstrap || "").includes("PROGRESS=100")) setBadge("badge-conn", "good", "Online · " + fmtDuration(tor.uptime));
  else setBadge("badge-conn", "warn", "Starting…");

  const safety = s.safety;
  const alert = $("alert");
  if (safety && safety.ok) {
    setBadge("badge-exit", "good", "No exit · reject *:*");
    alert.hidden = true;
  } else if (safety) {
    setBadge("badge-exit", "bad", "EXIT CONFIGURATION DETECTED");
    alert.hidden = false;
    alert.textContent = "Warning: Tor reported an exit configuration. The dashboard stopped Tor immediately. " + (safety.problems || []).join("; ");
  }

  const set = s.settings || {};
  if (set.Nickname) { $("nickname").textContent = set.Nickname; document.title = set.Nickname + " · Tor Middle Relay"; }
  $("fingerprint").textContent = tor.fingerprint ? "Fingerprint " + tor.fingerprint.replace(/(.{4})/g, "$1 ").trim() : (s.error ? "Error: " + s.error : "–");

  const pair = (v) => v ? `↓ ${fmtBytes(v[0])} · ↑ ${fmtBytes(v[1])}` : "–";
  const sum = (v) => v ? fmtBytes(v[0] + v[1]) : "–";
  $("t-today").textContent = sum(st.today); $("t-today-s").textContent = pair(st.today);
  $("t-month").textContent = sum(st.month); $("t-month-s").textContent = pair(st.month);
  $("t-total").textContent = sum(st.total);
  $("t-total-s").textContent = st.since ? "since " + fmtDate(st.since) + (st.persisted ? "" : " (not saved)") : "–";

  const c = s.connections || {};
  const orc = c.tor_or_connections || {};
  const connected = orc.CONNECTED || 0;
  $("c-total").textContent = s.connected ? String(connected) : "–";
  $("c-split").textContent = s.connected ? `TCP: ${c.tcp_inbound} in · ${c.tcp_outbound} out` : "–";

  const tr = s.traffic || {};
  fillTable("relay-table", [
    ["Status", s.connected ? (tor.liveness === "up" ? "Network reachable" : tor.liveness) : "not connected"],
    ["Tor version", tor.version],
    ["Uptime", tor.uptime ? fmtDuration(tor.uptime) : null],
    ["Detected address", tor.address],
    ["ORPort reachable (self-test)", tor.reachable_or === "1" ? "yes" : tor.reachable_or === "0" ? "not yet / no" : null],
    ["In consensus", tor.in_consensus ? "yes" : "not yet (takes a few hours)"],
    ["Flags", (tor.flags || []).join(", ")],
    ["Consensus bandwidth", tor.consensus_bandwidth ? tor.consensus_bandwidth + " (unit ≈ KB/s)" : null],
    ["Received since Tor start", fmtBytes(tr.read_since_start)],
    ["Sent since Tor start", fmtBytes(tr.written_since_start)],
  ]);

  const connRows = [
    ["Tor connections (open)", connected],
    ["TCP inbound (ORPort)", c.tcp_inbound],
    ["TCP outbound", c.tcp_outbound],
  ];
  for (const [k, v] of Object.entries(orc)) if (k !== "CONNECTED") connRows.push([`Tor connections (${k.toLowerCase()})`, v]);
  if (s.accounting) {
    const a = s.accounting;
    const b = (a.bytes || "").split(" ").map(Number), left = (a["bytes-left"] || "").split(" ").map(Number);
    connRows.push(["Data limit used", b.length === 2 ? `↓ ${fmtBytes(b[0])} · ↑ ${fmtBytes(b[1])}` : null]);
    connRows.push(["Data limit remaining", left.length === 2 ? `↓ ${fmtBytes(left[0])} · ↑ ${fmtBytes(left[1])}` : null]);
    connRows.push(["Period ends", a["interval-end"]]);
    connRows.push(["Hibernating", a.hibernating]);
  }
  fillTable("conn-table", connRows);

  // Tor reports bandwidth options in bytes/s; 0 and the 1 GB default mean "no limit".
  const bw = (v) => v === undefined ? null : (v === "0" || v === "1073741824") ? "unlimited" : fmtBytes(v) + "/s";
  const flag = (k, good) => [k, set[k], set[k] === good ? "ok" : "bad"];
  fillTable("settings-table", [
    flag("ExitRelay", "0"),
    ["ExitPolicy", set.ExitPolicy, set.ExitPolicy === "reject *:*" ? "ok" : "bad"],
    ["Effective exit policy",
      !safety ? null : !safety.ok ? "EXIT DETECTED" : safety.exit_policy ? safety.exit_policy.join(", ") : "descriptor not built yet",
      safety && safety.ok ? "ok" : "bad"],
    flag("IPv6Exit", "0"),
    flag("BridgeRelay", "0"),
    flag("SocksPort", "0"),
    ["Nickname", set.Nickname],
    ["ContactInfo", set.ContactInfo],
    ["ORPort", set.ORPort],
    ["Address", set.Address || "auto-detect"],
    ["DirCache", set.DirCache],
    ["RelayBandwidthRate", bw(set.RelayBandwidthRate)],
    ["RelayBandwidthBurst", bw(set.RelayBandwidthBurst)],
    ["MaxAdvertisedBandwidth", bw(set.MaxAdvertisedBandwidth)],
    ["AccountingMax", set.AccountingMax === "0" ? "no limit" : set.AccountingMax ? fmtBytes(set.AccountingMax) : null],
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
  dayChart.setData(st.days || []);
  $("footer").textContent = s.updated ? "Updated " + fmtFull(s.updated) : "";
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
  try { status = await getJSON("api/status"); renderStatus(); return true; }
  catch (e) { setBadge("badge-conn", "warn", "Dashboard not reachable"); return false; }
}
async function pollHistory() {
  try {
    const d = await getJSON("api/history?range=" + historyRange);
    if (d.range !== historyRange) return;
    const now = Math.floor(Date.now() / 1000);
    historyChart.setData(d.points, [now - RANGE_SECONDS[historyRange], now], d.res);
    $("history-sub").textContent = d.res >= 3600 ? "· 1 h averages" : "· 1 min averages";
  } catch (e) { /* ignore */ }
}

for (const b of $("history-range").querySelectorAll("button")) {
  b.addEventListener("click", () => {
    historyRange = b.dataset.range;
    for (const o of $("history-range").querySelectorAll("button")) o.setAttribute("aria-pressed", String(o === b));
    historyChart.view = null;
    historyChart.clearSelection();
    pollHistory();
  });
}

// ==================================================================
// Setup page
// ==================================================================
const RATE_HINT = "Leave empty for no limit. Applies to each direction separately.";
const SECTIONS = [
  {
    title: "Identity",
    fields: [
      { key: "NICKNAME", label: "Nickname", type: "text", maxlength: 19, required: true,
        hint: "1–19 letters or digits. Shown on Tor Metrics." },
      { key: "CONTACT_INFO", label: "Contact info", type: "text", maxlength: 500,
        hint: "How the Tor Project can reach you, e.g. Your Name <you@example.com>. Strongly recommended." },
    ],
  },
  {
    title: "Network",
    fields: [
      { key: "RELAY_ADDRESS", label: "Public address", type: "text", placeholder: "auto-detect",
        hint: "Leave empty to let Tor detect the public IP. Set it only if detection fails (NAT, VPN)." },
      { key: "OR_IPV6", label: "IPv6 on the ORPort", type: "select",
        options: [["auto", "Automatic – use IPv6 if available"], ["1", "Always"], ["0", "Never (IPv4 only)"]] },
      { key: "DIR_CACHE", label: "Directory cache", type: "select",
        options: [["1", "Enabled (recommended)"], ["0", "Disabled"]],
        hint: "Serving directory information is normal for a middle relay and needs a little extra traffic." },
    ],
  },
  {
    title: "Bandwidth",
    fields: [
      { key: "BANDWIDTH_RATE", label: "Sustained rate", type: "size", units: "rate", hint: RATE_HINT },
      { key: "BANDWIDTH_BURST", label: "Burst rate", type: "size", units: "rate",
        hint: "Short peaks above the sustained rate. Must be at least the sustained rate." },
      { key: "MAX_ADVERTISED_BANDWIDTH", label: "Advertised bandwidth", type: "size", units: "rate",
        hint: "Limits how much traffic the network sends your way, without a hard cap." },
    ],
  },
  {
    title: "Data limit",
    fields: [
      { key: "ACCOUNTING_MAX", label: "Maximum per period", type: "size", units: "bytes",
        hint: "When the relay has received or sent this much, it hibernates until the next period. Empty = no limit." },
      { key: "ACCOUNTING_START", label: "Period starts", type: "period" },
    ],
  },
  {
    title: "Family",
    fields: [
      { key: "MYFAMILY", label: "Other relays you run", type: "family",
        hint: "Fingerprints (40 hex characters) of your other relays, one per line. Leave empty if this is your only relay." },
    ],
  },
];

let setup = null;          // last /api/settings response
const inputs = {};         // key -> { get(), set(value), el }
const resets = new Set();  // keys to reset to the .env value

function parseSize(value, units) {
  const m = /^\s*(\d+)\s*([A-Za-z]*)\s*$/.exec(value || "");
  if (!m) return { n: "", unit: units[2] };
  const unit = units.find((u) => u.toLowerCase() === m[2].toLowerCase()) || m[2] || units[2];
  return { n: m[1], unit };
}

function buildInput(f, units) {
  const id = "f-" + f.key;
  if (f.type === "select") {
    const s = el("select", { id });
    for (const [v, label] of f.options) s.appendChild(el("option", { value: v }, label));
    return { el: s, get: () => s.value, set: (v) => { s.value = v; }, controls: [s] };
  }
  if (f.type === "size") {
    const list = units[f.units];
    const wrap = el("div", { class: "size" });
    const n = el("input", { id, type: "number", min: "1", step: "1", inputmode: "numeric", placeholder: "no limit" });
    const u = el("select", { "aria-label": f.label + " unit" });
    for (const unit of list) u.appendChild(el("option", { value: unit }, unit));
    wrap.append(n, u);
    return {
      el: wrap, controls: [n, u],
      get: () => (n.value.trim() ? `${n.value.trim()} ${u.value}` : ""),
      set: (v) => {
        const p = parseSize(v, list);
        if (p.unit && !list.includes(p.unit)) u.appendChild(el("option", { value: p.unit }, p.unit));
        n.value = p.n; u.value = p.unit;
      },
    };
  }
  if (f.type === "period") {
    const wrap = el("div", { class: "period" });
    const kind = el("select", { id, "aria-label": "Period" });
    for (const [v, l] of [["month", "Monthly, on day"], ["week", "Weekly, on weekday"], ["day", "Daily"]]) kind.appendChild(el("option", { value: v }, l));
    const day = el("select", { "aria-label": "Day" });
    const time = el("input", { type: "time", "aria-label": "Time", value: "00:00" });
    const fillDays = () => {
      const cur = day.value;
      day.replaceChildren();
      if (kind.value === "month") for (let i = 1; i <= 28; i++) day.appendChild(el("option", { value: String(i) }, String(i)));
      if (kind.value === "week") ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        .forEach((d, i) => day.appendChild(el("option", { value: String(i + 1) }, d)));
      day.hidden = kind.value === "day";
      if ([...day.options].some((o) => o.value === cur)) day.value = cur;
    };
    kind.addEventListener("change", fillDays);
    wrap.append(kind, day, time);
    wrap.appendChild(el("span", { class: "muted small" }, "(UTC)"));
    return {
      el: wrap, controls: [kind, day, time],
      get: () => {
        const t = time.value || "00:00";
        return kind.value === "day" ? `day ${t}` : `${kind.value} ${day.value} ${t}`;
      },
      set: (v) => {
        const m = /^(day|week|month)(?: (\d{1,2}))?(?: (\d{1,2}):(\d{2}))?$/.exec(v || "") || [];
        kind.value = m[1] || "month"; fillDays();
        if (m[2]) day.value = String(Number(m[2]));
        time.value = m[3] ? `${m[3].padStart(2, "0")}:${m[4]}` : "00:00";
      },
    };
  }
  if (f.type === "family") {
    const t = el("textarea", { id, rows: "3", spellcheck: "false", placeholder: "ABCD…1234" });
    return {
      el: t, controls: [t],
      get: () => t.value.split(/[\s,]+/).filter(Boolean).join(","),
      set: (v) => { t.value = (v || "").split(",").filter(Boolean).join("\n"); },
    };
  }
  const i = el("input", { id, type: "text", autocomplete: "off", spellcheck: "false" });
  if (f.maxlength) i.setAttribute("maxlength", String(f.maxlength));
  if (f.placeholder) i.setAttribute("placeholder", f.placeholder);
  return { el: i, get: () => i.value.trim(), set: (v) => { i.value = v || ""; }, controls: [i] };
}

function buildSetupForm() {
  const root = $("setup-fields");
  root.replaceChildren();
  for (const sec of SECTIONS) {
    const card = el("section", { class: "card form-card" });
    card.appendChild(el("h2", {}, sec.title));
    for (const f of sec.fields) {
      const row = el("div", { class: "field" });
      const labelRow = el("div", { class: "field-label" });
      labelRow.appendChild(el("label", { for: "f-" + f.key }, f.label));
      const meta = el("span", { class: "field-meta", id: "meta-" + f.key });
      labelRow.appendChild(meta);
      row.appendChild(labelRow);
      const input = buildInput(f, setup.units);
      inputs[f.key] = input;
      row.appendChild(input.el);
      if (f.hint) row.appendChild(el("p", { class: "field-hint" }, f.hint));
      row.appendChild(el("p", { class: "field-error", id: "err-" + f.key, hidden: "" }));
      for (const c of input.controls) {
        c.addEventListener("input", updateDirty);
        c.addEventListener("change", updateDirty);
      }
      card.appendChild(row);
    }
    root.appendChild(card);
  }
}

function fieldMeta(key) {
  const f = setup.fields[key];
  const meta = $("meta-" + key);
  meta.replaceChildren();
  if (resets.has(key)) {
    meta.appendChild(el("span", { class: "pill" }, "will reset to .env"));
  } else if (f.source === "dashboard") {
    meta.appendChild(el("span", { class: "pill accent" }, "set here"));
    if (setup.editable) {
      const b = el("button", { type: "button", class: "link" }, "reset to .env");
      b.title = ".env value: " + (f.env || "(empty)");
      b.addEventListener("click", () => { resets.add(key); inputs[key].set(f.env); updateDirty(); });
      meta.appendChild(b);
    }
  } else {
    meta.appendChild(el("span", { class: "pill" }, "from .env"));
  }
  if (f.pending) meta.appendChild(el("span", { class: "pill warn" }, "restart pending"));
}

function collectChanges() {
  const changes = {};
  for (const key of Object.keys(setup.fields)) {
    const value = inputs[key].get();
    if (resets.has(key)) changes[key] = null;
    else if (value !== setup.fields[key].value) changes[key] = value;
  }
  return changes;
}

function updateDirty() {
  if (!setup) return;
  // A field edited after "reset to .env" is a normal change again.
  for (const key of [...resets]) if (inputs[key].get() !== setup.fields[key].env) resets.delete(key);
  const n = Object.keys(collectChanges()).length;
  $("setup-status").textContent = n ? `${n} unsaved change${n === 1 ? "" : "s"}` : "";
  for (const id of ["btn-save", "btn-save-restart", "btn-discard"]) $(id).disabled = !setup.editable || !n;
  for (const key of Object.keys(setup.fields)) fieldMeta(key);
}

function showFieldErrors(errors) {
  for (const key of Object.keys(setup.fields)) {
    const e = $("err-" + key);
    e.hidden = !errors[key];
    e.textContent = errors[key] || "";
  }
}

function applySettings(view) {
  setup = view;
  csrfToken = view.csrf || csrfToken;
  if (!$("setup-fields").childElementCount) buildSetupForm();
  resets.clear();
  for (const [key, f] of Object.entries(view.fields)) inputs[key].set(f.value);
  for (const input of Object.values(inputs)) for (const c of input.controls) c.disabled = !view.editable;
  $("setup-readonly").hidden = view.editable;
  $("btn-restart").disabled = !view.editable;
  $("btn-restart-pending").disabled = !view.editable;
  $("setup-orport").textContent = String(view.or_port);
  const rej = $("setup-rejected");
  rej.hidden = view.overrides_status !== "rejected";
  rej.textContent = "Your saved settings were not applied at the last start, Tor is running with the .env values instead: " + (view.overrides_message || "unknown reason").replace(/\.+$/, "") + ". Correct the setting below and save again.";
  $("setup-pending").hidden = !Object.values(view.fields).some((f) => f.pending);
  showFieldErrors({});
  updateDirty();
}

async function loadSettings() {
  try { applySettings(await getJSON("api/settings")); }
  catch (e) { $("setup-status").textContent = "Could not load settings (" + e.message + ")"; }
}

async function saveSettings(restart) {
  const changes = collectChanges();
  if (!Object.keys(changes).length && !restart) return;
  if (restart && !confirm("Save and restart Tor now? The relay is offline for up to a minute.")) return;
  $("setup-status").textContent = "Saving…";
  try {
    const res = await postJSON("api/settings", { values: changes, restart });
    applySettings({ ...res.settings, csrf: csrfToken });
    $("setup-status").textContent = restart ? "" : "Saved. Restart Tor to apply.";
    if (res.restarting) waitForRestart();
  } catch (e) {
    showFieldErrors(e.fields || {});
    $("setup-status").textContent = e.fields && Object.keys(e.fields).length ? "Please fix the highlighted fields." : "Error: " + e.message;
  }
}

async function restartTor() {
  if (!confirm("Restart Tor now? The relay is offline for up to a minute.")) return;
  try {
    await postJSON("api/control", { action: "restart" });
    waitForRestart();
  } catch (e) { $("setup-status").textContent = "Error: " + e.message; }
}

// Tor shuts down gracefully, the container stops and Docker starts it
// again. Wait until a fresh Tor answers.
function waitForRestart() {
  const ov = $("overlay");
  ov.hidden = false;
  $("overlay-title").textContent = "Restarting Tor…";
  $("overlay-text").textContent = "Tor is shutting down gracefully (up to 30 s). Docker starts it again right after.";
  $("overlay-close").hidden = true;
  const started = Date.now();
  let wentDown = false;
  const tick = async () => {
    let s = null;
    try { s = await getJSON("api/status"); } catch (e) { wentDown = true; }
    const elapsed = (Date.now() - started) / 1000;
    if (s && !s.connected) wentDown = true;
    if (s && s.connected && (wentDown || s.tor.uptime < elapsed)) {
      $("overlay-title").textContent = "Tor is running again";
      $("overlay-text").textContent = "The new settings are active.";
      status = s; renderStatus();
      await loadSettings();
      setTimeout(() => { ov.hidden = true; }, 1200);
      return;
    }
    if (elapsed > 150) {
      $("overlay-title").textContent = "Still waiting…";
      $("overlay-text").textContent = "Tor has not come back yet. Check `docker compose logs` – the container needs a restart policy such as `restart: unless-stopped`.";
      $("overlay-close").hidden = false;
    }
    setTimeout(tick, 2000);
  };
  setTimeout(tick, 3000);
}

$("setup-form").addEventListener("submit", (ev) => { ev.preventDefault(); saveSettings(false); });
$("btn-save-restart").addEventListener("click", () => saveSettings(true));
$("btn-discard").addEventListener("click", () => applySettings(setup));
$("btn-restart").addEventListener("click", restartTor);
$("btn-restart-pending").addEventListener("click", restartTor);
$("overlay-close").addEventListener("click", () => { $("overlay").hidden = true; });

// ==================================================================
// Pages & polling
// ==================================================================
function showPage() {
  const page = location.hash === "#setup" ? "setup" : "overview";
  $("page-overview").hidden = page !== "overview";
  $("page-setup").hidden = page !== "setup";
  for (const p of ["overview", "setup"]) {
    const t = $("tab-" + p);
    if (p === page) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
  }
  hideTip();
  if (page === "setup") loadSettings();
  else { liveChart.render(); historyChart.render(); dayChart.render(); }
}
window.addEventListener("hashchange", showPage);

showPage();
pollLive(); pollStatus(); pollHistory();
setInterval(pollLive, 2000);
setInterval(pollStatus, 5000);
setInterval(pollHistory, 60000);
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { liveChart.render(); historyChart.render(); dayChart.render(); }, 150);
});
