/**
 * state.mjs — resumable bookkeeping and the single-run lock.
 *
 * `state.json` is the memory of the archiver: which recordings are already on disk, which failed, and
 * which are permanently skipped. It is written atomically so an interrupted run never corrupts it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCK_TTL_MS = 6 * 60 * 60 * 1000;

/** @param {string} stateDir */
export const stateFile = (stateDir) => path.join(stateDir, "state.json");
/** @param {string} stateDir */
export const indexFile = (stateDir) => path.join(stateDir, "index.json");
/** @param {string} stateDir */
export const sessionFile = (stateDir) => path.join(stateDir, "session.json");
/** @param {string} stateDir */
const lockDir = (stateDir) => path.join(stateDir, "sync.lock");

/** @param {string} stateDir */
export function loadState(stateDir) {
  mkdirSync(stateDir, { recursive: true });
  try {
    const state = JSON.parse(readFileSync(stateFile(stateDir), "utf8"));
    state.clips ??= {};
    state.failures ??= {};
    state.skipped ??= {};
    return state;
  } catch {
    return { version: 1, createdAt: new Date().toISOString(), clips: {}, failures: {}, skipped: {} };
  }
}

/**
 * @param {string} stateDir
 * @param {object} state
 */
export function saveState(stateDir, state) {
  const target = stateFile(stateDir);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, target);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes the run lock, cleaning up a stale one (dead pid, or older than six hours).
 *
 * @param {string} stateDir
 * @param {{ log: (message: string) => void }} logger
 * @returns {boolean} false when another live run holds the lock.
 */
export function acquireLock(stateDir, logger) {
  mkdirSync(stateDir, { recursive: true });
  const dir = lockDir(stateDir);
  try {
    mkdirSync(dir);
  } catch {
    let holder = Number.NaN;
    let age = 0;
    try {
      holder = Number(readFileSync(path.join(dir, "pid"), "utf8").trim());
      age = Date.now() - statSync(dir).mtimeMs;
    } catch {
      /* a lock without a pid file is stale by definition */
    }
    if (pidAlive(holder) && age < LOCK_TTL_MS) {
      logger.log(`lock: run ${holder} is still active — this run stops`);
      return false;
    }
    logger.log(`lock: removed stale lock (pid ${holder || "?"}, age ${Math.round(age / 1000)}s)`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
  }
  writeFileSync(path.join(dir, "pid"), String(process.pid));
  return true;
}

/** @param {string} stateDir */
export function releaseLock(stateDir) {
  try {
    rmSync(lockDir(stateDir), { recursive: true, force: true });
  } catch {
    /* nothing sensible to do here */
  }
}

/** Removes a saved login session (used after a token or login-limit error). */
export function dropSession(stateDir) {
  if (!existsSync(sessionFile(stateDir))) return;
  try {
    rmSync(sessionFile(stateDir), { force: true });
  } catch {
    /* nothing sensible to do here */
  }
}
