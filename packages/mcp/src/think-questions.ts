/**
 * Questions for a thinking agent that runs on a timer, never the same one twice in a row of hundreds.
 *
 * A questions file holds lists and templates. A line `@coin = bitcoin (BTC) | ether (ETH)` defines a list; a
 * line with `{coin}` in it is a template, asked once for each item of the list. Other lines are questions as
 * they are. Every question the file can make goes into one order, shuffled with a seed per pass, and a run
 * takes the next one it has not asked recently.
 */

/** Every question the file makes, templates filled in with each item of their list. */
export function expandQuestions(text: string): string[] {
  const lists = new Map<string, string[]>();
  const templates: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const def = /^@([a-z][a-z0-9_]*)\s*=\s*(.+)$/i.exec(line);
    if (def) {
      lists.set(def[1]!.toLowerCase(), def[2]!.split("|").map((s) => s.trim()).filter(Boolean));
      continue;
    }
    templates.push(line);
  }
  const out: string[] = [];
  for (const t of templates) {
    const names = [...new Set([...t.matchAll(/\{([a-z][a-z0-9_]*)\}/gi)].map((m) => m[1]!.toLowerCase()))];
    let filled = [t];
    for (const name of names) {
      const items = lists.get(name);
      if (!items || items.length === 0) throw new Error(`the questions file uses {${name}} but defines no @${name} list`);
      filled = filled.flatMap((q) => items.map((item) => q.replace(new RegExp(`\\{${name}\\}`, "gi"), item)));
    }
    out.push(...filled);
  }
  return [...new Set(out)];
}

/** A small seeded generator (mulberry32): the same seed gives the same order on every machine. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const next = random(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * The question for run number `n` (how many runs came before it): the next in a shuffled pass through all of
 * them, a new shuffle each pass, skipping anything asked recently.
 */
export function pickQuestion(all: readonly string[], n: number, recent: ReadonlySet<string> = new Set()): string {
  if (all.length === 0) throw new Error("no questions");
  const passes = new Map<number, string[]>();
  const order = (pass: number) => passes.get(pass) ?? passes.set(pass, shuffled(all, 0x51ed + pass)).get(pass)!;
  for (let k = 0; k < all.length; k++) {
    const i = n + k;
    const q = order(Math.floor(i / all.length))[i % all.length]!;
    if (!recent.has(q)) return q;
  }
  return order(Math.floor(n / all.length))[n % all.length]!;
}
