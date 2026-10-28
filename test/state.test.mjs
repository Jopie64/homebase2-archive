import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireLock,
  dropSession,
  indexFile,
  loadState,
  releaseLock,
  saveState,
  sessionFile,
  stateFile,
} from "../lib/state.mjs";

let dir;
const messages = [];
const logger = { log: (message) => messages.push(message) };

const deadPid = () => {
  const child = spawnSync(process.execPath, ["-e", ""]);
  return child.pid;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "hba-state-"));
  messages.length = 0;
});

afterEach(() => {
  releaseLock(dir);
});

describe("state files", () => {
  it("places its files in the state directory", () => {
    expect(stateFile(dir)).toBe(path.join(dir, "state.json"));
    expect(indexFile(dir)).toBe(path.join(dir, "index.json"));
    expect(sessionFile(dir)).toBe(path.join(dir, "session.json"));
  });

  it("returns an empty skeleton when there is no state yet", () => {
    const state = loadState(dir);
    expect(state.clips).toEqual({});
    expect(state.failures).toEqual({});
    expect(state.skipped).toEqual({});
    expect(state.version).toBe(1);
  });

  it("creates the state directory if needed", () => {
    const nested = path.join(dir, "a/b/c");
    saveState(nested, { version: 1, clips: { x: { file: "y" } }, failures: {}, skipped: {} });
    expect(existsSync(stateFile(nested))).toBe(true);
  });

  it("round-trips clips, failures and skips", () => {
    const state = { version: 1, clips: { a: { file: "2026-10/a.mp4" } }, failures: { b: { attempts: 1 } }, skipped: { c: { reason: "no key" } } };
    saveState(dir, state);
    const loaded = loadState(dir);
    expect(loaded.clips).toEqual(state.clips);
    expect(loaded.failures).toEqual(state.failures);
    expect(loaded.skipped).toEqual(state.skipped);
  });

  it("writes atomically, leaving no temporary file behind", () => {
    saveState(dir, { version: 1, clips: { a: {} }, failures: {}, skipped: {} });
    expect(existsSync(`${stateFile(dir)}.tmp`)).toBe(false);
    // The state file is valid JSON at every moment, so a crash cannot leave half a file.
    expect(() => JSON.parse(readFileSync(stateFile(dir), "utf8"))).not.toThrow();
  });

  it("adds the missing sections when loading a partial state file", () => {
    writeFileSync(stateFile(dir), JSON.stringify({ version: 1, clips: { a: { file: "x" } } }));
    const state = loadState(dir);
    expect(state.failures).toEqual({});
    expect(state.skipped).toEqual({});
  });

  it("starts empty instead of crashing on a corrupt state file", () => {
    writeFileSync(stateFile(dir), "{ not json");
    expect(loadState(dir).clips).toEqual({});
  });
});

describe("lock", () => {
  it("grants the lock and keeps a live holder out", () => {
    expect(acquireLock(dir, logger)).toBe(true);
    expect(acquireLock(dir, logger)).toBe(false);
    expect(messages.join("\n")).toMatch(/still active/);
  });

  it("grants the lock again after a release", () => {
    acquireLock(dir, logger);
    releaseLock(dir);
    expect(acquireLock(dir, logger)).toBe(true);
  });

  it("cleans up a lock left behind by a dead process", () => {
    const lock = path.join(dir, "sync.lock");
    mkdirSync(lock);
    writeFileSync(path.join(lock, "pid"), String(deadPid()));
    expect(acquireLock(dir, logger)).toBe(true);
    expect(messages.join("\n")).toMatch(/removed stale lock/);
  });

  it("cleans up a lock without a pid file", () => {
    mkdirSync(path.join(dir, "sync.lock"));
    expect(acquireLock(dir, logger)).toBe(true);
    expect(messages.join("\n")).toMatch(/removed stale lock \(pid \?/);
  });

  it("records its own pid so a second run can see the holder", () => {
    acquireLock(dir, logger);
    expect(readFileSync(path.join(dir, "sync.lock", "pid"), "utf8")).toBe(String(process.pid));
  });
});

describe("dropSession", () => {
  it("removes a stored session", () => {
    writeFileSync(sessionFile(dir), "{}");
    dropSession(dir);
    expect(existsSync(sessionFile(dir))).toBe(false);
  });

  it("is a no-op when there is no session", () => {
    expect(() => dropSession(dir)).not.toThrow();
  });
});
