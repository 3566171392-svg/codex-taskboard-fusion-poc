/**
 * Build the workspace used by the real Review Gate demo.
 *
 * Starts from a small Node project with a real, substantiable defect: the sign
 * of a 2D cross product is inverted relative to its own docstring, and the
 * accompanying test asserts the documented orientation, so the suite genuinely
 * fails. The executor can fix it; a reviewer can verify it from the files.
 *
 * Only writes inside FUSION_POC_FIXTURE_ROOT (default D:\poc\gate-demo).
 */
import fs from "node:fs/promises";
import path from "node:path";

const root = process.env.FUSION_POC_FIXTURE_ROOT ?? "D:\\poc\\gate-demo";
if (!path.win32.isAbsolute(root) || !root.toLowerCase().startsWith("d:\\poc\\")) {
  console.error(`refusing to write outside D:\\poc: ${root}`);
  process.exit(2);
}

await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(path.join(root, "src"), { recursive: true });
await fs.mkdir(path.join(root, "test"), { recursive: true });

await fs.writeFile(path.join(root, "package.json"), JSON.stringify({
  name: "gate-demo",
  version: "0.1.0",
  private: true,
  type: "module",
  scripts: { test: "node --test" },
}, null, 2) + "\n", "utf8");

await fs.writeFile(path.join(root, "README.md"), [
  "# gate-demo",
  "",
  "Scratch project for the Codex-native Review Gate demo.",
  "",
  "`src/geometry.js` documents its coordinate convention; `test/geometry.test.js`",
  "asserts that documented behaviour.",
  "",
].join("\n"), "utf8");

// The defect: the docstring says counter-clockwise is +1, the code returns -1.
await fs.writeFile(path.join(root, "src", "geometry.js"), `/**
 * Geometry helpers.
 *
 * Coordinate convention: a right-handed frame with y pointing up, so the
 * standard 2D cross product z-component is (ax * by - ay * bx).
 */

/**
 * Orientation sign of b relative to a.
 *
 * @returns {number} 1 when b is counter-clockwise from a, -1 when clockwise,
 *                   0 when the vectors are parallel.
 */
export function crossSign(ax, ay, bx, by) {
  if ([ax, ay, bx, by].some((value) => typeof value !== "number" || Number.isNaN(value))) {
    throw new TypeError("crossSign requires numeric operands");
  }
  const cross = ax * by - ay * bx;
  if (cross > 0) return -1;
  if (cross < 0) return 1;
  return 0;
}
`, "utf8");

await fs.writeFile(path.join(root, "test", "geometry.test.js"), `import test from "node:test";
import assert from "node:assert/strict";

import { crossSign } from "../src/geometry.js";

test("counter-clockwise orientation is +1", () => {
  // (1,0) -> (0,1) turns counter-clockwise in a y-up frame.
  assert.equal(crossSign(1, 0, 0, 1), 1);
});

test("clockwise orientation is -1", () => {
  assert.equal(crossSign(0, 1, 1, 0), -1);
});

test("parallel vectors are 0", () => {
  assert.equal(crossSign(1, 1, 2, 2), 0);
});

test("orientation is antisymmetric", () => {
  assert.equal(crossSign(2, 3, -3, 2), -crossSign(-3, 2, 2, 3));
});

test("non-numeric operands are rejected", () => {
  assert.throws(() => crossSign("1", 0, 0, 1), /numeric operands/);
});
`, "utf8");

const files = [];
const walk = async (dir, prefix) => {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
    else files.push(rel);
  }
};
await walk(root, "");
console.log(JSON.stringify({ root, files: files.sort() }, null, 2));
