/** Text that came from someone else's server, made safe to store: one line, bounded, printable. */
export const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const printable = [...v].map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? " " : ch)).join("");
  const s = printable.replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};
