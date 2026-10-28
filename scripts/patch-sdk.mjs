#!/usr/bin/env node
/**
 * patch-sdk.mjs — makes `decodeRecording` importable from @mega-yfue/eufy-sdk.
 *
 * Why: the SDK does not export the decoder (upstream gap, tracked as mega-yfue/eufy-sdk#526), while the
 * function itself is present in the bundle as `function decodeRecording(...)`. An ESM module may export
 * an existing top-level binding after the fact, so a single extra export line is enough.
 *
 * Idempotent: recognises its own marker and does nothing on a second run. `install.sh` runs it after
 * every `npm install`. When the SDK exports the decoder itself (or a host application can use
 * `camera.downloadRecording()`), this file can be removed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ROOT } from "../lib/config.mjs";

const MARK = "/* homebase2-archive:extra-exports */";
const WANTED = ["decodeRecording", "receiveRecording", "homeBase2RecordingPath"];

const file = path.join(ROOT, "node_modules", "@mega-yfue", "eufy-sdk", "dist", "index.js");

let source;
try {
  source = readFileSync(file, "utf8");
} catch {
  console.error(`patch-sdk: ${file} not found — run npm install first`);
  process.exit(1);
}

if (source.includes(MARK)) {
  console.log("patch-sdk: already patched, nothing to do");
  process.exit(0);
}

/** Names that already appear in an `export { ... }` block. */
function alreadyExported(src) {
  const names = new Set();
  for (const block of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const entry of block[1].split(",")) {
      const name = entry.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) names.add(name.replace(/^["']|["']$/g, ""));
    }
  }
  return names;
}

const exported = alreadyExported(source);
const isDeclared = (name) =>
  new RegExp(`(^|\\n)(?:async\\s+)?(?:function|const|let|var|class)\\s+${name}\\b`).test(source);

const toAdd = [];
for (const name of WANTED) {
  if (exported.has(name)) continue;
  if (!isDeclared(name)) {
    console.error(`patch-sdk: ${name} is not a top-level binding in this bundle — skipped`);
    continue;
  }
  toAdd.push(name);
}

if (!toAdd.length) {
  console.log("patch-sdk: every target is already exported, nothing to add");
  process.exit(0);
}

writeFileSync(file, `${source}\n${MARK}\nexport { ${toAdd.join(", ")} };\n`);
console.log(`patch-sdk: added extra export (${toAdd.join(", ")})`);
