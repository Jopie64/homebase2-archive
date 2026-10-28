#!/usr/bin/env node
/**
 * stats.mjs — summary of the archive: clips, skipped recordings (grouped by reason) and failures.
 */
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "./lib/config.mjs";
import { stateFile } from "./lib/state.mjs";

let cfg;
try {
  cfg = loadConfig();
} catch (error) {
  console.error(`config: ${error?.message ?? error}`);
  process.exit(1);
}
if (!existsSync(stateFile(cfg.stateDir))) {
  console.error(`no state file at ${stateFile(cfg.stateDir)} — nothing archived yet`);
  process.exit(1);
}

const state = JSON.parse(readFileSync(stateFile(cfg.stateDir), "utf8"));
const clips = Object.values(state.clips ?? {});
const skipped = Object.values(state.skipped ?? {});
const failures = Object.entries(state.failures ?? {});

/** Groups values by a field, with long digit runs collapsed so similar messages share a row. */
const group = (items, key) => {
  const counts = {};
  for (const item of items) {
    const label = String(item[key] ?? "?").replace(/[0-9]{2,}/g, "N").slice(0, 46);
    counts[label] = (counts[label] ?? 0) + 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
};

console.log(`clips: ${clips.length} | skipped: ${skipped.length} | failures: ${failures.length}`);
if (clips.length) {
  const times = clips.map((clip) => String(clip.start)).sort();
  const bytes = clips.reduce((sum, clip) => sum + (Number(clip.bytes) || 0), 0);
  console.log(`  range: ${times[0]} → ${times[times.length - 1]}  (${(bytes / 1073741824).toFixed(2)} GiB)`);
  const months = {};
  for (const clip of clips) {
    const month = String(clip.start).slice(0, 7);
    months[month] = (months[month] ?? 0) + 1;
  }
  console.log(`  months: ${Object.entries(months).sort().map(([month, count]) => `${month}:${count}`).join(" ")}`);
}
for (const [label, count] of group(skipped, "reason")) console.log(`  skipped ${count}x ${label}`);
for (const [label, count] of group(failures.map(([, failure]) => failure), "error")) {
  console.log(`  failed ${count}x ${label}`);
}
