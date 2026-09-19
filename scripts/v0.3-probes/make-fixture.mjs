/**
 * Build the live workspace used by scripts/live-review-loop.mjs.
 *
 * Copies the verified Phase 0 fixture and writes a deliberately defective
 * `src/math.js` (mobile cross-product sign wrong) so the reviewer has a real,
 * substantiable defect and the executor has a real file to fix.
 *
 * Only writes inside FUSION_POC_FIXTURE_ROOT.
 */
import fs from "node:fs/promises";
import path from "node:path";

const root = process.env.FUSION_POC_FIXTURE_ROOT ?? "D:\\poc\\v3-workspace";
const source = process.env.FUSION_POC_FIXTURE_SOURCE ?? "D:\\poc\\project";

const allowedPrefix = "d:\\poc\\";
if (!path.win32.isAbsolute(root) || !root.toLowerCase().startsWith(allowedPrefix)) {
  console.error(`refusing to write outside ${allowedPrefix}: ${root}`);
  process.exit(2);
}

const defective = `/**
 * Tiny arithmetic helpers.
 * Same style as src/stats.js: guard the inputs, then compute.
 */

export function divide(a, b) {
  if (typeof a !== "number" || Number.isNaN(a)) {
    throw new TypeError("divide requires numeric operands");
  }
  if (typeof b !== "number" || Number.isNaN(b)) {
    throw new TypeError("divide requires numeric operands");
  }
  if (b === 0) {
    throw new TypeError("divide requires a non-zero divisor");
  }
  return a / b;
}

/**
 * Sign of the 2D cross product (a x b).
 * Returns 1 when b is counter-clockwise from a, -1 when clockwise, 0 when parallel.
 */
export function crossSign(ax, ay, bx, by) {
  const cross = ax * by - ay * bx;
  if (cross > 0) return -1;
  if (cross < 0) return 1;
  return 0;
}
`;

await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(path.join(root, "src"), { recursive: true });
await fs.mkdir(path.join(root, "test"), { recursive: true });

for (const name of ["package.json", "README.md"]) {
  try { await fs.copyFile(path.join(source, name), path.join(root, name)); } catch { /* optional */ }
}
try { await fs.copyFile(path.join(source, "src", "stats.js"), path.join(root, "src", "stats.js")); } catch { /* optional */ }
try { await fs.copyFile(path.join(source, "test", "stats.test.js"), path.join(root, "test", "stats.test.js")); } catch { /* optional */ }
try { await fs.copyFile(path.join(source, "test", "math.test.js"), path.join(root, "test", "math.test.js")); } catch { /* optional */ }
try { await fs.copyFile(path.join(source, "src", "math.js"), path.join(root, "src", "math.js")); } catch { /* optional */ }

await fs.writeFile(path.join(root, "src", "math.js"), defective, "utf8");
await fs.writeFile(path.join(root, "test", "cross.test.js"), `import test from "node:test";
import assert from "node:assert/strict";

import { crossSign } from "../src/math.js";

test("crossSign reports counter-clockwise as +1", () => {
  assert.equal(crossSign(1, 0, 0, 1), 1);
});

test("crossSign reports clockwise as -1", () => {
  assert.equal(crossSign(0, 1, 1, 0), -1);
});

test("crossSign reports parallel vectors as 0", () => {
  assert.equal(crossSign(1, 1, 2, 2), 0);
});
`, "utf8");

const files = [];
for (const entry of await fs.readdir(root, { withFileTypes: true })) {
  if (entry.isFile()) files.push(entry.name);
}
console.log(JSON.stringify({ root, files: files.sort() }, null, 2));
