import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../lib/log.mjs";

let dir;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "hba-log-"));
  // The logger mirrors to stdout; keep the test output readable.
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createLogger", () => {
  it("writes a timestamped line to stdout and to the log file", () => {
    const logger = createLogger({ stateDir: dir });
    logger.log("hello station");
    const contents = readFileSync(path.join(dir, "sync.log"), "utf8");
    expect(contents).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z hello station\n$/);
    expect(logger.file).toBe(path.join(dir, "sync.log"));
  });

  it("appends across runs instead of truncating", () => {
    createLogger({ stateDir: dir }).log("first run");
    createLogger({ stateDir: dir }).log("second run");
    const contents = readFileSync(path.join(dir, "sync.log"), "utf8");
    expect(contents).toContain("first run");
    expect(contents).toContain("second run");
  });

  it("creates the state directory", () => {
    const nested = path.join(dir, "deep/state");
    createLogger({ stateDir: nested }).log("x");
    expect(existsSync(path.join(nested, "sync.log"))).toBe(true);
  });

  it("rotates the log once it grows past 5 MB", () => {
    const log = path.join(dir, "sync.log");
    writeFileSync(log, "x".repeat(5 * 1024 * 1024 + 1));
    createLogger({ stateDir: dir }).log("fresh");
    expect(statSync(path.join(dir, "sync.log.1")).size).toBeGreaterThan(5 * 1024 * 1024);
    expect(readFileSync(log, "utf8")).toContain("fresh");
    expect(readFileSync(log, "utf8")).not.toContain("xxxx");
  });

  it("keeps running when the log cannot be written", () => {
    // A state directory that cannot be created must not stop an archive run. A regular file in the
    // way is portable; do not use a made-up /proc path (mkdir under procfs hangs on Android).
    const blocker = path.join(dir, "not-a-directory");
    writeFileSync(blocker, "");
    const logger = createLogger({ stateDir: path.join(blocker, "state") });
    expect(() => logger.log("still works")).not.toThrow();
  });
});
