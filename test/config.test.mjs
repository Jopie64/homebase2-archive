import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configPath, expandPath, loadConfig } from "../lib/config.mjs";

const home = os.homedir();
let dir;

const writeConfig = (contents) => {
  const file = path.join(dir, "config.json");
  writeFileSync(file, typeof contents === "string" ? contents : JSON.stringify(contents));
  vi.stubEnv("HBA_CONFIG", file);
  return file;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "hba-config-"));
  for (const key of Object.keys(process.env)) if (key.startsWith("HBA_")) vi.stubEnv(key, undefined);
  vi.stubEnv("HBA_CONFIG", path.join(dir, "missing.json"));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("expandPath", () => {
  it("expands a leading tilde", () => {
    expect(expandPath("~/clips")).toBe(path.join(home, "clips"));
    expect(expandPath("~")).toBe(home);
  });

  it("leaves bare commands and absolute paths alone", () => {
    expect(expandPath("ffmpeg")).toBe("ffmpeg");
    expect(expandPath("/usr/bin/ffmpeg")).toBe("/usr/bin/ffmpeg");
  });
});

describe("loadConfig", () => {
  it("falls back to generic defaults when there is no config file", () => {
    const config = loadConfig();
    expect(config.configFound).toBe(false);
    expect(config.outDir).toBe(path.join(home, "clips"));
    expect(config.stateDir).toBe(path.join(home, ".local/state/homebase2-archive"));
    expect(config.credentialsFile).toBe(path.join(home, ".config/homebase2-archive/credentials"));
    expect(config.ffmpeg).toBe("ffmpeg");
    expect(config.nodeBin).toBe("node");
    expect(config.stationSn).toBe("");
    expect(config.maxClips).toBe(300);
    expect(config.pageSize).toBe(100);
  });

  it("reports the config file it looked at", () => {
    const file = writeConfig({ stationSn: "T8010TEST" });
    expect(configPath()).toBe(file);
    expect(loadConfig().configFile).toBe(file);
  });

  it("applies file values", () => {
    writeConfig({ stationSn: "T8010TEST", outDir: "/mnt/archive", maxClips: 5 });
    const config = loadConfig();
    expect(config.configFound).toBe(true);
    expect(config.stationSn).toBe("T8010TEST");
    expect(config.outDir).toBe("/mnt/archive");
    expect(config.maxClips).toBe(5);
  });

  it("lets the environment override the file", () => {
    writeConfig({ outDir: "/mnt/archive", maxClips: 5 });
    vi.stubEnv("HBA_OUT_DIR", "/mnt/other");
    vi.stubEnv("HBA_MAX_CLIPS", "7");
    const config = loadConfig();
    expect(config.outDir).toBe("/mnt/other");
    expect(config.maxClips).toBe(7);
  });

  it("ignores empty environment variables", () => {
    writeConfig({ maxClips: 42 });
    vi.stubEnv("HBA_MAX_CLIPS", "");
    expect(loadConfig().maxClips).toBe(42);
  });

  it("expands a tilde in path-like settings, including ffmpeg and node", () => {
    writeConfig({
      outDir: "~/clips",
      stateDir: "~/state",
      credentialsFile: "~/creds",
      ffmpeg: "~/.local/bin/ffmpeg",
      nodeBin: "~/node/bin/node",
    });
    const config = loadConfig();
    for (const key of ["outDir", "stateDir", "credentialsFile", "ffmpeg", "nodeBin"]) {
      expect(config[key].startsWith(home), key).toBe(true);
    }
  });

  it("counts the state directory as a path, not as a command", () => {
    writeConfig({ stateDir: "~/somewhere" });
    expect(loadConfig().stateDir).toBe(path.join(home, "somewhere"));
  });

  it("rejects unknown settings so typos do not pass unnoticed", () => {
    writeConfig({ stationSnn: "typo" });
    expect(() => loadConfig()).toThrow(/unknown setting\(s\) stationSnn/);
  });

  it("rejects a config file that is not a JSON object", () => {
    writeConfig("[1, 2]");
    expect(() => loadConfig()).toThrow(/must contain a JSON object/);
  });

  it("rejects invalid JSON with the file name", () => {
    const file = writeConfig("{ oops");
    expect(() => loadConfig()).toThrow(new RegExp(`cannot parse ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });

  it("rejects a non-numeric setting instead of running with NaN", () => {
    writeConfig({ clipTimeoutMs: "soon" });
    expect(() => loadConfig()).toThrow(/clipTimeoutMs must be a non-negative number/);
  });

  it("rejects an empty path setting", () => {
    writeConfig({ outDir: "" });
    expect(() => loadConfig()).toThrow(/outDir must be a non-empty string/);
  });

  it("trims string settings", () => {
    writeConfig({ since: "  20260101  " });
    expect(loadConfig().since).toBe("20260101");
  });

  it("keeps config-discovery stable across calls", () => {
    writeConfig({ maxClips: 3 });
    expect(existsSync(configPath())).toBe(true);
    expect(loadConfig().maxClips).toBe(3);
    expect(loadConfig().maxClips).toBe(3);
  });
});
