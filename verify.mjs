#!/usr/bin/env node
/**
 * verify.mjs — checks the archiver's bookkeeping against what is actually on disk.
 *
 * Without arguments: state.json against the files (existence, size, month layout).
 * --probe=N: decode N random clips through `ffmpeg -f null -` to prove they are playable.
 * --list-failures: show failed recordings with their error.
 *
 * Exit code 1 when a recorded file is missing or has an unexpected size.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { loadConfig } from "./lib/config.mjs";
import { stateFile } from "./lib/state.mjs";

let cfg;
try {
  cfg = loadConfig();
} catch (error) {
  console.error(`config: ${error?.message ?? error}`);
  process.exit(1);
}
const args = process.argv.slice(2);
const probeCount = Number((args.find((a) => a.startsWith("--probe=")) ?? "").split("=")[1] ?? 0);

if (!existsSync(stateFile(cfg.stateDir))) {
  console.error(`no state file at ${stateFile(cfg.stateDir)} — nothing archived yet`);
  process.exit(1);
}

const state = JSON.parse(readFileSync(stateFile(cfg.stateDir), "utf8"));
const entries = Object.entries(state.clips ?? {});
const failures = Object.entries(state.failures ?? {});
const skipped = Object.entries(state.skipped ?? {});

let missing = 0;
let sizeMismatch = 0;
const byMonth = new Map();
for (const [id, clip] of entries) {
  const file = path.join(cfg.outDir, clip.file);
  const month = String(clip.file).slice(0, 7);
  byMonth.set(month, (byMonth.get(month) ?? 0) + 1);
  if (!existsSync(file)) {
    if (missing < 5) console.log(`missing: ${id} → ${clip.file}`);
    missing++;
    continue;
  }
  const actual = statSync(file).size;
  if (clip.bytes && actual !== clip.bytes) {
    if (sizeMismatch < 5) console.log(`size differs: ${clip.file} (state ${clip.bytes}, disk ${actual})`);
    sizeMismatch++;
  }
}

console.log(`state: ${entries.length} clips, ${failures.length} failed, ${skipped.length} skipped`);
console.log(`disk:  ${missing} missing, ${sizeMismatch} with a different size`);
const months = [...byMonth.entries()].sort();
if (months.length) console.log(`months: ${months.map(([month, count]) => `${month}:${count}`).join(" ")}`);
if (entries.length) {
  const totalBytes = entries.reduce((sum, [, clip]) => sum + (Number(clip.bytes) || 0), 0);
  const average = Math.round(totalBytes / entries.length / 1024);
  console.log(`size:  ${(totalBytes / 1073741824).toFixed(2)} GiB (average ${average} KiB)`);
}

if (args.includes("--list-failures") && failures.length) {
  console.log("\nfailed:");
  for (const [id, failure] of failures.slice(0, 25)) {
    console.log(`  ${failure.start} ${id} attempts=${failure.attempts} ${String(failure.error).slice(0, 120)}`);
  }
}

if (args.includes("--list-skipped") && skipped.length) {
  console.log("\nskipped:");
  for (const [id, entry] of skipped.slice(0, 25)) {
    console.log(`  ${entry.start} ${id} ${String(entry.reason).slice(0, 120)}`);
  }
}

if (probeCount > 0 && entries.length) {
  const sample = [...entries].sort(() => Math.random() - 0.5).slice(0, probeCount);
  console.log(`\nprobe: decoding ${sample.length} clips`);
  let bad = 0;
  for (const [, clip] of sample) {
    const file = path.join(cfg.outDir, clip.file);
    const done = spawnSync(cfg.ffmpeg, ["-v", "error", "-i", file, "-f", "null", "-"], { encoding: "utf8" });
    if (done.status === 0) {
      console.log(`  ok ${clip.file} (${clip.frames} frames, ${clip.missing} missing)`);
    } else {
      bad++;
      const reason = String(done.stderr ?? done.error ?? "").trim().split("\n")[0]?.slice(0, 160);
      console.log(`  FAIL ${clip.file}: ${reason}`);
    }
  }
  console.log(bad ? `${bad} of ${sample.length} failed` : "all probed clips decode");
}

process.exit(missing || sizeMismatch ? 1 : 0);
