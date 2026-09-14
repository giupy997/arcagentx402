// Compile-time guarantees. Checked by `tsc` (vitest typecheck also picks up *.test-d.ts).
import { addUsdc6, toUsdc18, usdc18, usdc6, type Usdc18, type Usdc6 } from "../src/index.js";

const six: Usdc6 = usdc6(1n);
const eighteen: Usdc18 = usdc18(1n);

// @ts-expect-error a Usdc18 must not be accepted where a Usdc6 is expected
addUsdc6(six, eighteen);

// @ts-expect-error raw bigints are not amounts
addUsdc6(six, 1n);

// @ts-expect-error a Usdc6 must not be assignable to Usdc18 without conversion
const wrong: Usdc18 = six;

const ok: Usdc18 = toUsdc18(six);
void ok;
void wrong;
