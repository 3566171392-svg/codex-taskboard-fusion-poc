/**
 * Reproduce the Windows path bug in test/app-server-client.test.mjs.
 *
 * The test spawns `node` with `new URL(...).pathname`, which on Windows yields
 * "/D:/...". `spawnSync(process.execPath, ["/D:/..."])` resolves the leading
 * slash as a drive-relative root, producing a non-existent path, so node exits
 * with code 1 before the fake server can speak. `fileURLToPath` yields the
 * correct "D:\\...".
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

const testFileUrl = new URL("../test/app-server-client.test.mjs", import.meta.url);
const viaPathname = testFileUrl.pathname;
const viaFileURLToPath = fileURLToPath(testFileUrl);

const fixture = path.join(path.dirname(viaFileURLToPath), "fake-path-probe.cjs");
fs.writeFileSync(fixture, 'process.stdin.resume();console.log("fake server up");\n');

const bad = spawnSync(process.execPath, [viaPathname], { encoding: "utf8" });
const good = spawnSync(process.execPath, [viaFileURLToPath.replace(/app-server-client\.test\.mjs$/, "fake-path-probe.cjs")], { encoding: "utf8" });

fs.rmSync(fixture, { force: true });

const firstErrorLine = String(bad.stderr).split("\n").find((l) => /Cannot find module|Error:/.test(l)) ?? null;
console.log(JSON.stringify({
  pathname_form: {
    value: viaPathname,
    exitStatus: bad.status,
    resolvedAs: String(bad.stderr).match(/Cannot find module '([^']+)'/)?.[1] ?? null,
    firstErrorLine,
  },
  fileURLToPath_form: {
    value: viaFileURLToPath,
    exitStatus: good.status,
    stdout: String(good.stdout).trim(),
  },
}, null, 2));
