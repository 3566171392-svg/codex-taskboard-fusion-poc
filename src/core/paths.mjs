/**
 * Platform-safe conversion from file URLs to filesystem paths.
 *
 * Why this exists: `new URL(...).pathname` returns "/D:/repo/file.mjs" for a
 * Windows file URL. Passing that to `spawn`, `fs`, or any path API makes Node
 * resolve it drive-relative, producing "D:\\D:\\repo\\file.mjs". The value looks
 * plausible, so the failure surfaces far from its cause.
 *
 * `node:url.fileURLToPath` is the platform-aware conversion and is the only
 * conversion used here. Native paths are passed through untouched so POSIX
 * behaviour is unchanged.
 */
import { fileURLToPath } from "node:url";
import path from "node:path";

const WINDOWS_DRIVE_ABSOLUTE = /^\/([A-Za-z]):(?:\/|$)/;

export class InvalidPathError extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidPathError";
  }
}

/**
 * Convert a file URL (URL instance or "file:..." string) or a native
 * filesystem path into a native filesystem path.
 */
export function toFilesystemPath(value) {
  if (value instanceof URL) {
    if (value.protocol !== "file:") {
      throw new InvalidPathError(`expected a file: URL, received ${value.protocol}`);
    }
    return fileURLToPath(value);
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new InvalidPathError("path must be a non-empty string or a file: URL");
  }

  if (value.startsWith("file:")) {
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new InvalidPathError(`invalid file URL: ${value}`);
    }
    if (parsed.protocol !== "file:") {
      throw new InvalidPathError(`expected a file: URL, received ${parsed.protocol}`);
    }
    return fileURLToPath(parsed);
  }

  // A URL pathname left as a bare string ("/D:/repo"). Accepting this silently
  // is the exact bug this module exists to prevent, so reject it on Windows
  // instead of producing "D:\\D:\\repo". POSIX treats it as an ordinary path.
  if (process.platform === "win32" && WINDOWS_DRIVE_ABSOLUTE.test(value)) {
    throw new InvalidPathError(
      `"${value}" looks like a URL pathname, not a Windows path; convert the file URL with toFilesystemPath() first`,
    );
  }

  return value;
}

/** True when the value denotes an absolute path on the running platform. */
export function isAbsolutePath(value) {
  return path.isAbsolute(toFilesystemPath(value));
}
