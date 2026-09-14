/**
 * Hero visuals, no dependencies:
 *  - rain: rows of monospace text drifting and flickering, fading out toward the middle
 *  - ring: a rotating torus of dots (the rail) with bright payment pulses running around it
 *  - scramble: the title decodes from random glyphs
 * Everything stops when the tab is hidden or the hero is off screen, and respects reduced motion.
 */
const GLYPHS = "!<>-_\\/[]{}=+*^?#$%&01ABCDEFx402";
const PHRASE = "agent payments on arc   x402   usdc   pay per call   verified   ";

function fitCanvas(c: HTMLCanvasElement): { w: number; h: number; ctx: CanvasRenderingContext2D } {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const r = c.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width));
  const h = Math.max(1, Math.round(r.height));
  if (c.width !== w * dpr || c.height !== h * dpr) {
    c.width = w * dpr;
    c.height = h * dpr;
  }
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h, ctx };
}

export function scrambleText(el: HTMLElement, finalText: string, durationMs = 1100): void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) { el.textContent = finalText; return; }
  const chars = [...finalText];
  const reveal = chars.map((ch, i) => (ch === " " ? 0 : 180 + (i / chars.length) * (durationMs - 180) + Math.random() * 160));
  const start = performance.now();
  el.setAttribute("aria-label", finalText);
  const tick = (now: number) => {
    const t = now - start;
    let done = true;
    const html = chars.map((ch, i) => {
      if (ch === " ") return " ";
      if (t >= reveal[i]!) return ch;
      done = false;
      const g = GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!;
      return `<span class="glow">${g.replace("<", "&lt;").replace(">", "&gt;").replace("&", "&amp;")}</span>`;
    }).join("");
    el.innerHTML = html;
    if (!done) requestAnimationFrame(tick);
    else el.textContent = finalText;
  };
  requestAnimationFrame(tick);
}

export function startHero(hero: HTMLElement): void {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rain = hero.querySelector<HTMLCanvasElement>("#rain");
  const ring = hero.querySelector<HTMLCanvasElement>("#ring");
  let visible = true;
  new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); }, { threshold: 0 }).observe(hero);
  const active = () => visible && !document.hidden;

  // ---------------------------------------------------------------- rain
  if (rain) {
    const rainCanvas: HTMLCanvasElement = rain;
    const FONT = 13;
    const LINE = 17;
    let rows: string[][] = [];
    let cols = 0;
    let offsets: number[] = [];
    let speeds: number[] = [];
    const build = () => {
      const { w, h } = fitCanvas(rain);
      cols = Math.ceil(w / (FONT * 0.6)) + 2;
      const n = Math.ceil((h * 0.62) / LINE);
      rows = Array.from({ length: n }, (_, r) => {
        const shift = Math.floor(Math.random() * PHRASE.length);
        return Array.from({ length: cols + PHRASE.length }, (_, i) => PHRASE[(i + shift + r * 7) % PHRASE.length]!);
      });
      offsets = rows.map(() => Math.random() * PHRASE.length * FONT * 0.6);
      speeds = rows.map((_, r) => (r % 2 ? -1 : 1) * (4 + Math.random() * 10));
    };
    build();
    new ResizeObserver(() => { build(); draw(performance.now()); }).observe(rain);
    let last = performance.now();
    function draw(now: number): void {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      const { w, h, ctx } = fitCanvas(rainCanvas);
      ctx.clearRect(0, 0, w, h);
      ctx.font = `400 ${FONT}px "JetBrains Mono", ui-monospace, monospace`;
      ctx.textBaseline = "top";
      const cellW = FONT * 0.6;
      const span = PHRASE.length * cellW;
      for (let r = 0; r < rows.length; r++) {
        const y = 6 + r * LINE;
        const fade = Math.max(0, 1 - y / (h * 0.6));
        if (fade <= 0) continue;
        const base = rows[r]!;
        // flicker without drift: a fresh copy of the phrase each frame with a couple of glyphs swapped
        const row = base.slice();
        if (!reduce) {
          const swaps = Math.random() < 0.6 ? 1 + Math.floor(Math.random() * 3) : 0;
          for (let k = 0; k < swaps; k++) {
            const i = Math.floor(Math.random() * row.length);
            if (row[i] !== " ") row[i] = GLYPHS[Math.floor(Math.random() * GLYPHS.length)]!;
          }
          offsets[r] = (offsets[r]! + speeds[r]! * dt + span) % span;
        }
        ctx.fillStyle = `rgba(214, 228, 255, ${0.22 * fade * fade})`;
        ctx.fillText(row.join(""), -offsets[r]!, y);
        // a brighter "decoded" fragment now and then
        if (!reduce && Math.random() < 0.012) {
          const i = Math.floor(Math.random() * cols);
          ctx.fillStyle = `rgba(141, 255, 197, ${0.55 * fade})`;
          ctx.fillText(row.slice(i, i + 6).join(""), i * cellW - offsets[r]! % cellW, y);
        }
      }
    }
    let acc = 0;
    const loop = (now: number) => {
      if (active() && now - acc > 55) { acc = now; draw(now); }
      if (!reduce) requestAnimationFrame(loop);
    };
    draw(performance.now());
    if (!reduce) requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- ring
  if (ring) {
    type P = { u: number; v: number };
    const R = 1;
    const r0 = 0.42;
    const points: P[] = [];
    const U = 44;
    for (let i = 0; i < U; i++) {
      const u = (i / U) * Math.PI * 2;
      const V = 22;
      for (let j = 0; j < V; j++) points.push({ u, v: (j / V) * Math.PI * 2 });
    }
    const pulses = Array.from({ length: 12 }, () => ({ u: Math.random() * Math.PI * 2, v: Math.random() * Math.PI * 2, speed: 0.5 + Math.random() * 0.9, dv: (Math.random() - 0.5) * 0.6 }));
    const project = (u: number, v: number, ax: number, ay: number) => {
      let x = (R + r0 * Math.cos(v)) * Math.cos(u);
      let y = r0 * Math.sin(v);
      let z = (R + r0 * Math.cos(v)) * Math.sin(u);
      // rotate around Y
      const cy = Math.cos(ay), sy = Math.sin(ay);
      [x, z] = [x * cy + z * sy, -x * sy + z * cy];
      // rotate around X
      const cx = Math.cos(ax), sx = Math.sin(ax);
      [y, z] = [y * cx - z * sx, y * sx + z * cx];
      // fixed diagonal roll around Z
      const cz = Math.cos(0.42), sz = Math.sin(0.42);
      [x, y] = [x * cz - y * sz, x * sz + y * cz];
      const f = 3.2;
      const s = f / (f + z);
      return { x: x * s, y: y * s, depth: (1 - z / (R + r0)) / 2 };
    };
    let t0 = performance.now();
    const draw = (now: number) => {
      const t = (now - t0) / 1000;
      const { w, h, ctx } = fitCanvas(ring);
      ctx.clearRect(0, 0, w, h);
      const scale = Math.min(w, h) * 0.27;
      const cx = w / 2;
      const cy = h / 2;
      const ax = 0.62 + Math.sin(t * 0.23) * 0.1;
      const ay = t * 0.22;
      for (const p of points) {
        const q = project(p.u + t * 0.05, p.v, ax, ay);
        const a = 0.3 + 0.7 * q.depth;
        const size = 1.05 + 1.55 * q.depth;
        ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(cx + q.x * scale, cy + q.y * scale, size, 0, Math.PI * 2);
        ctx.fill();
      }
      for (const pl of pulses) {
        const head = pl.u + t * pl.speed;
        for (let k = 14; k >= 0; k--) {
          const q = project(head - k * 0.045 + t * 0.05, pl.v + Math.sin(t * 0.7 + pl.u) * pl.dv - k * 0.01, ax, ay);
          const a = (1 - k / 15) * (0.35 + 0.65 * q.depth);
          ctx.fillStyle = k === 0 ? `rgba(220,255,236,${a})` : `rgba(141,255,197,${(a * 0.7).toFixed(3)})`;
          ctx.beginPath();
          ctx.arc(cx + q.x * scale, cy + q.y * scale, k === 0 ? 2.6 : 1.8 * (1 - k / 18), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    };
    const loop = (now: number) => {
      if (active()) draw(now); else t0 += 16;
      requestAnimationFrame(loop);
    };
    if (reduce) draw(performance.now() + 4000); else requestAnimationFrame(loop);
    new ResizeObserver(() => draw(performance.now())).observe(ring);
  }
}

/** Reveal terminal lines one by one when the terminal scrolls into view. */
export function typeTerminal(term: HTMLElement): void {
  const lines = [...term.querySelectorAll<HTMLElement>(".ln")];
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) { lines.forEach((l) => l.classList.add("on")); return; }
  const io = new IntersectionObserver((es) => {
    if (!es.some((e) => e.isIntersecting)) return;
    io.disconnect();
    lines.forEach((l, i) => setTimeout(() => l.classList.add("on"), 120 + i * (i === 1 ? 260 : 330)));
  }, { threshold: 0.35 });
  io.observe(term);
}
