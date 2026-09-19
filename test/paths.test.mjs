import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { InvalidPathError, isAbsolutePath, toFilesystemPath } from "../src/core/paths.mjs";

/**
 * Regression for the bug that made `npm test` fail on Windows:
 * `new URL(...).pathname` yields "/D:/repo/file.mjs", and passing that to
 * spawn/fs produces "D:\\D:\\repo\\file.mjs".
 */
test("file URLs convert to native paths on every platform", () => {
  if (process.platform === "win32") {
    assert.equal(toFilesystemPath(new URL("file:///D:/repo/file.mjs")), "D:\\repo\\file.mjs");
    assert.equal(toFilesystemPath("file:///D:/repo/file.mjs"), "D:\\repo\\file.mjs");
    assert.equal(toFilesystemPath(new URL("file:///D:/repo/a%20b/c.mjs")), "D:\\repo\\a b\\c.mjs");
  } else {
    assert.equal(toFilesystemPath(new URL("file:///repo/file.mjs")), "/repo/file.mjs");
    assert.equal(toFilesystemPath("file:///repo/file.mjs"), "/repo/file.mjs");
  }
});

test("converts this test file's own URL to a path that actually exists", () => {
  const native = toFilesystemPath(import.meta.url);
  assert.ok(path.isAbsolute(native), `expected an absolute path, got ${native}`);
  assert.equal(native, fileURLToPath(import.meta.url));
  assert.ok(fs.existsSync(native), `converted path does not exist: ${native}`);
  // The regression: a URL pathname would start with "/" before the drive.
  assert.ok(!/^[\\/][A-Za-z]:/.test(native), `path still looks URL-shaped: ${native}`);
  assert.ok(!native.startsWith("\\\\?\\D:\\D:"), `path was double-prefixed: ${native}`);
});

test("native paths pass through unchanged", () => {
  const native = process.platform === "win32" ? "D:\\repo\\file.mjs" : "/repo/file.mjs";
  assert.equal(toFilesystemPath(native), native);
  assert.equal(isAbsolutePath(native), true);
});

test("a bare Windows URL pathname is rejected instead of silently mangled", () => {
  if (process.platform !== "win32") return;
  assert.throws(() => toFilesystemPath("/D:/repo/file.mjs"), InvalidPathError);
});

test("non-file URLs and empty values are rejected", () => {
  assert.throws(() => toFilesystemPath(new URL("https://example.com/x")), InvalidPathError);
  assert.throws(() => toFilesystemPath(""), InvalidPathError);
  assert.throws(() => toFilesystemPath(null), InvalidPathError);
});
