/**
 * config.mjs — one place where every setting comes from.
 *
 * Precedence (highest wins): CLI flags (handled by the caller) > environment > config.json > defaults.
 * `config.json` lives next to this project unless `HBA_CONFIG` points somewhere else. It is git-ignored:
 * it holds deployment specifics (station serial, output paths, node/ffmpeg locations).
 */
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Project root (the directory that holds this file's parent). */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const home = os.homedir();
const xdg = (name, fallback) => process.env[name] || path.join(home, fallback);

/** Every key of the effective configuration, with its default and the env var that overrides it. */
const KEYS = {
  credentialsFile: {
    default: path.join(xdg("XDG_CONFIG_HOME", ".config"), "homebase2-archive/credentials"),
    env: "HBA_CREDENTIALS",
  },
  stationSn: { default: "", env: "HBA_STATION_SN" },
  outDir: { default: path.join(home, "clips"), env: "HBA_OUT_DIR" },
  stateDir: {
    default: path.join(xdg("XDG_STATE_HOME", ".local/state"), "homebase2-archive"),
    env: "HBA_STATE_DIR",
  },
  ffmpeg: { default: "ffmpeg", env: "HBA_FFMPEG" },
  nodeBin: { default: "node", env: "HBA_NODE_BIN" },
  maxClips: { default: 300, env: "HBA_MAX_CLIPS" },
  pageSize: { default: 100, env: "HBA_PAGE_SIZE" },
  since: { default: "", env: "HBA_SINCE" },
  clipTimeoutMs: { default: 90000, env: "HBA_CLIP_TIMEOUT_MS" },
  maxAttempts: { default: 3, env: "HBA_MAX_ATTEMPTS" },
  recoverAfter: { default: 3, env: "HBA_RECOVER_AFTER" },
  maxRecoveries: { default: 40, env: "HBA_MAX_RECOVERIES" },
  level2TimeoutMs: { default: 60000, env: "HBA_LEVEL2_TIMEOUT_MS" },
};

const NUMERIC = new Set([
  "maxClips",
  "pageSize",
  "clipTimeoutMs",
  "maxAttempts",
  "recoverAfter",
  "maxRecoveries",
  "level2TimeoutMs",
]);

const PATH_KEYS = new Set(["credentialsFile", "outDir", "stateDir"]);
/** Settings that may carry a path but also a bare command name (`ffmpeg`, `node`). */
const PATHISH_KEYS = new Set([...PATH_KEYS, "ffmpeg", "nodeBin"]);

/** Resolves the absolute path of the config file. */
export function configPath() {
  return path.resolve(process.env.HBA_CONFIG || path.join(ROOT, "config.json"));
}

/** Expands a leading `~` and makes a path absolute (relative paths stay relative to cwd). */
export function expandPath(value) {
  if (typeof value !== "string" || !value) return value;
  if (value === "~") return home;
  if (value.startsWith("~/")) return path.join(home, value.slice(2));
  return value;
}

function readConfigFile(file) {
  if (!existsSync(file)) return {};
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`cannot parse ${file}: ${String(error?.message ?? error)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${file} must contain a JSON object`);
  }
  const unknown = Object.keys(parsed).filter((key) => !(key in KEYS));
  if (unknown.length) {
    throw new Error(`${file}: unknown setting(s) ${unknown.join(", ")}`);
  }
  return parsed;
}

/**
 * Builds the effective configuration.
 *
 * @returns {Record<string, unknown>} every known key, resolved and validated.
 */
export function loadConfig() {
  const file = configPath();
  const fromFile = readConfigFile(file);
  const config = {};

  for (const [key, spec] of Object.entries(KEYS)) {
    let value = spec.default;
    if (fromFile[key] !== undefined) value = fromFile[key];
    const envValue = process.env[spec.env];
    if (envValue !== undefined && envValue !== "") value = envValue;

    if (NUMERIC.has(key)) {
      const number = Number(value);
      if (!Number.isFinite(number) || number < 0) {
        throw new Error(`setting ${key} must be a non-negative number (got ${JSON.stringify(value)})`);
      }
      value = number;
    } else if (PATHISH_KEYS.has(key)) {
      if (typeof value !== "string" || !value) throw new Error(`setting ${key} must be a non-empty string`);
      value = expandPath(value);
    } else {
      if (typeof value !== "string") value = String(value);
      value = value.trim();
    }
    config[key] = value;
  }

  config.configFile = file;
  config.configFound = existsSync(file);
  return config;
}
