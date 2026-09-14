/**
 * Small SVG chart kit following the data-viz method: thin marks, hairline solid grid, one axis,
 * crosshair tooltip on lines, per-mark tooltip on bars, a table twin behind every chart.
 */
const NS = "http://www.w3.org/2000/svg";
const el = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
};

export interface Point { x: number; y: number; label: string }
export interface LineSpec {
  points: Point[];
  color?: string; // css var
  yFormat?: (v: number) => string;
  xFormat?: (v: number) => string;
  yMin?: number; // force a floor (e.g. 0)
  floor?: { value: number; label: string }; // reference hairline
  area?: boolean;
  width?: number;
  height?: number;
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function tip(container: HTMLElement): HTMLDivElement {
  let t = container.querySelector<HTMLDivElement>(".tip");
  if (!t) {
    t = document.createElement("div");
    t.className = "tip";
    container.appendChild(t);
  }
  return t;
}

function placeTip(t: HTMLDivElement, container: HTMLElement, px: number, py: number): void {
  t.style.display = "block";
  const cw = container.clientWidth;
  const tw = t.offsetWidth;
  t.style.left = `${Math.max(0, Math.min(cw - tw, px + 12 > cw - tw ? px - tw - 12 : px + 12))}px`;
  t.style.top = `${Math.max(0, py - 34)}px`;
}

export function lineChart(container: HTMLElement, spec: LineSpec): void {
  const W = spec.width ?? 640;
  const H = spec.height ?? 220;
  const m = { l: 44, r: 12, t: 12, b: 26 };
  const pts = spec.points;
  container.classList.remove("stale");
  container.querySelectorAll("svg").forEach((s) => s.remove());
  if (pts.length < 2) {
    container.innerHTML = '<div class="empty">Not enough data in this window yet.</div>';
    return;
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  let yMin = spec.yMin ?? Math.min(...ys);
  let yMax = Math.max(...ys);
  if (spec.floor) { yMin = Math.min(yMin, spec.floor.value); yMax = Math.max(yMax, spec.floor.value); }
  if (yMax === yMin) { yMax = yMin + (yMin === 0 ? 1 : Math.abs(yMin) * 0.1); }
  const pad = (yMax - yMin) * 0.12;
  yMax += pad;
  if (spec.yMin === undefined) yMin -= pad;
  const sx = (x: number) => m.l + ((x - x0) / (x1 - x0)) * (W - m.l - m.r);
  const sy = (y: number) => m.t + (1 - (y - yMin) / (yMax - yMin)) * (H - m.t - m.b);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  const yf = spec.yFormat ?? ((v) => String(v));
  const xf = spec.xFormat ?? ((v) => String(v));
  for (const tv of niceTicks(yMin, yMax)) {
    svg.appendChild(el("line", { x1: m.l, x2: W - m.r, y1: sy(tv), y2: sy(tv), stroke: "var(--grid)", "stroke-width": 1 }));
    svg.appendChild(el("text", { x: m.l - 6, y: sy(tv) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)", style: "font-variant-numeric: tabular-nums" }, yf(tv)));
  }
  svg.appendChild(el("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: "var(--axis)", "stroke-width": 1 }));
  const xTicks = 4;
  for (let i = 0; i <= xTicks; i++) {
    const xv = x0 + ((x1 - x0) * i) / xTicks;
    svg.appendChild(el("text", { x: sx(xv), y: H - 8, "text-anchor": i === 0 ? "start" : i === xTicks ? "end" : "middle", "font-size": 11, fill: "var(--muted)" }, xf(xv)));
  }
  if (spec.floor) {
    svg.appendChild(el("line", { x1: m.l, x2: W - m.r, y1: sy(spec.floor.value), y2: sy(spec.floor.value), stroke: "var(--axis)", "stroke-width": 1 }));
    svg.appendChild(el("text", { x: m.l + 4, y: sy(spec.floor.value) - 4, "text-anchor": "start", "font-size": 10.5, fill: "var(--muted)" }, spec.floor.label));
  }
  const color = spec.color ?? "var(--series-1)";
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join(" ");
  if (spec.area) {
    svg.appendChild(el("path", { d: `${d} L${sx(x1).toFixed(1)},${H - m.b} L${sx(x0).toFixed(1)},${H - m.b} Z`, fill: color, opacity: 0.1 }));
  }
  svg.appendChild(el("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  const last = pts[pts.length - 1]!;
  svg.appendChild(el("circle", { cx: sx(last.x), cy: sy(last.y), r: 4, fill: color, stroke: "var(--surface)", "stroke-width": 2 }));
  svg.appendChild(el("text", { x: sx(last.x) - 8, y: sy(last.y) - 9, "text-anchor": "end", "font-size": 11.5, "font-weight": 600, fill: "var(--ink)" }, yf(last.y)));
  // hover layer
  const cross = el("line", { x1: 0, x2: 0, y1: m.t, y2: H - m.b, stroke: "var(--axis)", "stroke-width": 1, style: "display:none" });
  const dot = el("circle", { r: 4, fill: color, stroke: "var(--surface)", "stroke-width": 2, style: "display:none" });
  svg.appendChild(cross);
  svg.appendChild(dot);
  const hit = el("rect", { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" });
  svg.appendChild(hit);
  const t = tip(container);
  const onMove = (ev: PointerEvent) => {
    const rect = svg.getBoundingClientRect();
    const xPx = ((ev.clientX - rect.left) / rect.width) * W;
    const xv = x0 + ((xPx - m.l) / (W - m.l - m.r)) * (x1 - x0);
    let best = pts[0]!;
    for (const p of pts) if (Math.abs(p.x - xv) < Math.abs(best.x - xv)) best = p;
    cross.setAttribute("x1", String(sx(best.x)));
    cross.setAttribute("x2", String(sx(best.x)));
    cross.style.display = "";
    dot.setAttribute("cx", String(sx(best.x)));
    dot.setAttribute("cy", String(sy(best.y)));
    dot.style.display = "";
    t.innerHTML = `<div class="t">${best.label}</div><div class="v">${yf(best.y)}</div>`;
    placeTip(t, container, (sx(best.x) / W) * rect.width, (sy(best.y) / H) * rect.height);
  };
  hit.addEventListener("pointermove", onMove);
  hit.addEventListener("pointerleave", () => { cross.style.display = "none"; dot.style.display = "none"; t.style.display = "none"; });
  container.prepend(svg);
}

export interface BarSpec {
  bars: Array<{ label: string; value: number; sub?: string }>;
  format?: (v: number) => string;
  color?: string;
  width?: number;
}

/** Horizontal bars, one hue, value at the tip, 4px rounded data-end. */
export function barChart(container: HTMLElement, spec: BarSpec): void {
  const W = spec.width ?? 640;
  const rowH = 34;
  const m = { l: 130, r: 70, t: 6, b: 6 };
  const bars = spec.bars;
  container.classList.remove("stale");
  container.querySelectorAll("svg").forEach((s) => s.remove());
  if (bars.length === 0) {
    container.innerHTML = '<div class="empty">No transactions in this window yet.</div>';
    return;
  }
  const H = m.t + m.b + rowH * bars.length;
  const max = Math.max(...bars.map((b) => b.value), 1e-12);
  const f = spec.format ?? ((v) => String(v));
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  const color = spec.color ?? "var(--series-1)";
  const t = tip(container);
  bars.forEach((b, i) => {
    const y = m.t + i * rowH + 7;
    const w = Math.max(2, ((W - m.l - m.r) * b.value) / max);
    svg.appendChild(el("text", { x: m.l - 10, y: y + 14, "text-anchor": "end", "font-size": 12.5, fill: "var(--ink-2)" }, b.label));
    const r = el("path", { d: roundedRight(m.l, y, w, 20, 4), fill: color });
    svg.appendChild(r);
    svg.appendChild(el("text", { x: m.l + w + 8, y: y + 14, "font-size": 12, "font-weight": 600, fill: "var(--ink)", style: "font-variant-numeric: tabular-nums" }, f(b.value)));
    const hit = el("rect", { x: 0, y: m.t + i * rowH, width: W, height: rowH, fill: "transparent" });
    hit.addEventListener("pointermove", (ev: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      t.innerHTML = `<div class="t">${b.label}${b.sub ? ` · ${b.sub}` : ""}</div><div class="v">${f(b.value)}</div>`;
      placeTip(t, container, ev.clientX - rect.left, ((y + 10) / H) * rect.height);
    });
    hit.addEventListener("pointerleave", () => { t.style.display = "none"; });
    svg.appendChild(hit);
  });
  container.prepend(svg);
}

function roundedRight(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  return `M${x},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h - rr} Q${x + w},${y + h} ${x + w - rr},${y + h} H${x} Z`;
}

export interface ColumnSpec {
  columns: Array<{ x: number; value: number; label: string }>;
  format?: (v: number) => string;
  xFormat?: (v: number) => string;
  color?: string;
  width?: number;
  height?: number;
}

/** Vertical columns from a baseline, <=24px thick, 2px surface gap, cap value on the extreme only. */
export function columnChart(container: HTMLElement, spec: ColumnSpec): void {
  const W = spec.width ?? 640;
  const H = spec.height ?? 220;
  const m = { l: 44, r: 12, t: 14, b: 26 };
  const cols = spec.columns;
  container.classList.remove("stale");
  container.querySelectorAll("svg").forEach((s) => s.remove());
  if (cols.length === 0) {
    container.innerHTML = '<div class="empty">Not enough data in this window yet.</div>';
    return;
  }
  const max = Math.max(...cols.map((c) => c.value), 1);
  const f = spec.format ?? ((v) => String(v));
  const xf = spec.xFormat ?? ((v) => String(v));
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" });
  const plotW = W - m.l - m.r;
  const slot = plotW / cols.length;
  const bw = Math.min(24, Math.max(2, slot - 2));
  const sy = (v: number) => m.t + (1 - v / (max * 1.12)) * (H - m.t - m.b);
  for (const tv of niceTicks(0, max * 1.12)) {
    svg.appendChild(el("line", { x1: m.l, x2: W - m.r, y1: sy(tv), y2: sy(tv), stroke: "var(--grid)", "stroke-width": 1 }));
    svg.appendChild(el("text", { x: m.l - 6, y: sy(tv) + 4, "text-anchor": "end", "font-size": 11, fill: "var(--muted)", style: "font-variant-numeric: tabular-nums" }, f(tv)));
  }
  svg.appendChild(el("line", { x1: m.l, x2: W - m.r, y1: H - m.b, y2: H - m.b, stroke: "var(--axis)", "stroke-width": 1 }));
  const color = spec.color ?? "var(--series-1)";
  const t = tip(container);
  const maxIdx = cols.reduce((bi, c, i) => (c.value > cols[bi]!.value ? i : bi), 0);
  cols.forEach((c, i) => {
    const x = m.l + i * slot + (slot - bw) / 2;
    const y = sy(c.value);
    const h = H - m.b - y;
    if (h > 0) svg.appendChild(el("path", { d: roundedTop(x, y, bw, h, 4), fill: color }));
    if (i === maxIdx && c.value > 0) svg.appendChild(el("text", { x: x + bw / 2, y: y - 5, "text-anchor": "middle", "font-size": 11, "font-weight": 600, fill: "var(--ink)" }, f(c.value)));
    const hit = el("rect", { x: m.l + i * slot, y: m.t, width: slot, height: H - m.t - m.b, fill: "transparent" });
    hit.addEventListener("pointermove", (ev: PointerEvent) => {
      const rect = svg.getBoundingClientRect();
      t.innerHTML = `<div class="t">${c.label}</div><div class="v">${f(c.value)}</div>`;
      placeTip(t, container, ev.clientX - rect.left, (y / H) * rect.height);
    });
    hit.addEventListener("pointerleave", () => { t.style.display = "none"; });
    svg.appendChild(hit);
  });
  const ticks = Math.min(4, cols.length - 1);
  for (let i = 0; i <= ticks; i++) {
    const idx = Math.round((i * (cols.length - 1)) / Math.max(1, ticks));
    const c = cols[idx]!;
    svg.appendChild(el("text", { x: m.l + idx * slot + slot / 2, y: H - 8, "text-anchor": i === 0 ? "start" : i === ticks ? "end" : "middle", "font-size": 11, fill: "var(--muted)" }, xf(c.x)));
  }
  container.prepend(svg);
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

/** Table twin: every chart has one; toggled by the card's "table" button. */
export function tableTwin(card: HTMLElement, headers: string[], rows: Array<Array<string | number>>, numeric: number[] = []): void {
  let wrap = card.querySelector<HTMLDivElement>(".tbl-wrap.twin");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "tbl-wrap twin hidden";
    card.appendChild(wrap);
    const btn = card.querySelector<HTMLButtonElement>(".tbl-toggle");
    const viz = card.querySelector<HTMLElement>(".viz");
    btn?.addEventListener("click", () => {
      const showing = !wrap!.classList.contains("hidden");
      wrap!.classList.toggle("hidden", showing);
      viz?.classList.toggle("hidden", !showing);
      btn.textContent = showing ? "table" : "chart";
    });
  }
  const esc = (s: string | number) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  wrap.innerHTML = `<table class="data"><thead><tr>${headers.map((h, i) => `<th${numeric.includes(i) ? ' class="num"' : ""}>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows
    .map((r) => `<tr>${r.map((c, i) => `<td${numeric.includes(i) ? ' class="num"' : ""}>${esc(c)}</td>`).join("")}</tr>`)
    .join("")}</tbody></table>`;
}
