#!/usr/bin/env node
/**
 * sync.mjs — archive eufy HomeBase 2 recordings as plain MP4 files.
 *
 * Route: log in through @mega-yfue/eufy-sdk, open a P2P session to the HomeBase, wait for the level-2
 * handshake, page through `history_record_info` (cursor = `yyyyMMddHHmmss` of the oldest row of the
 * previous page), ask each camera for its recording (`camera.downloadRecording()`, which fetches the
 * cipher's ECC key, downloads and decrypts), and mux the returned elementary streams to MP4 with ffmpeg.
 *
 * One run = one login, one session, sequential downloads: the HomeBase does not tolerate parallel
 * transfers. State makes every run resumable and a lock prevents overlapping runs.
 *
 * Usage:
 *   node sync.mjs                  archive new recordings (at most `maxClips`)
 *   node sync.mjs --list           show what is pending, download nothing
 *   node sync.mjs --all            no limit for this run
 *   node sync.mjs --limit 50       explicit limit
 *   node sync.mjs --since 20260101 only recordings from this day on
 *   node sync.mjs --index-only     dump the station index to the state directory and stop
 *   node sync.mjs --force          retry recordings that already failed or were skipped
 *   node sync.mjs --print-config   show the resolved configuration and exit
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { EufyMega, FileSessionStore, RecordingDownloadError } from "@mega-yfue/eufy-sdk";
import { parseArgs } from "./lib/cli.mjs";
import { loadConfig } from "./lib/config.mjs";
import { createLogger } from "./lib/log.mjs";
import {
  channelOf,
  clipTarget,
  isPending,
  nextFrontier,
  reachedKnownTerritory,
  recordingName,
  toCursor,
} from "./lib/record.mjs";
import {
  acquireLock,
  dropSession,
  indexFile,
  loadState,
  releaseLock,
  saveState,
  sessionFile,
} from "./lib/state.mjs";

// ---------------------------------------------------------------------------
// Configuration and CLI
// ---------------------------------------------------------------------------
let cfg;
try {
  cfg = loadConfig();
} catch (error) {
  console.error(`config: ${error?.message ?? error}`);
  process.exit(1);
}
const { log } = createLogger({ stateDir: cfg.stateDir });

const args = process.argv.slice(2);

if (args.includes("--print-config")) {
  console.log(JSON.stringify(cfg, null, 2));
  process.exit(0);
}

const { mode: MODE, limit, since } = parseArgs(args, cfg);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/**
 * Renders an error with its cause chain. Node's fetch reports "fetch failed" and hides the useful part
 * (ECONNRESET, ETIMEDOUT, a TLS problem) one or two levels down in `cause`.
 */
function describeError(error) {
  const parts = [String(error?.message ?? error)];
  let cause = error?.cause;
  for (let depth = 0; cause && depth < 3; depth++) {
    parts.push(String(cause?.code ?? cause?.message ?? cause));
    cause = cause?.cause;
  }
  return parts.join(" <- ");
}
/**
 * Reads `EMAIL`/`PASSWORD`/`COUNTRY` from the credentials file. The older `EUFY_`-prefixed names are
 * accepted too, so an existing setup keeps working.
 *
 * @param {string} file
 */
function loadCreds(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(`credentials file not found: ${file}`);
  }
  const values = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^\s*([A-Z_]+)\s*=\s*'?(.*?)'?\s*$/);
    if (match) values[match[1].replace(/^EUFY_/, "")] = match[2];
  }
  if (!values.EMAIL || !values.PASSWORD) {
    throw new Error(`EMAIL/PASSWORD not found in ${file}`);
  }
  return { email: values.EMAIL, password: values.PASSWORD, countryCode: values.COUNTRY || "NL" };
}

/**
 * Picks the HomeBase to talk to: the configured serial, or the only HomeBase in the account.
 *
 * @param {Array<Record<string, any>>} devices
 */
function pickStation(devices) {
  const isStation = (device) =>
    device.deviceClass === "homebase" ||
    /homebase|station/i.test(String(device.category ?? "")) ||
    /^T80\d\d/.test(String(device.model ?? device.raw?.device_model ?? ""));

  if (cfg.stationSn) {
    const found = devices.find((device) => device.sn === cfg.stationSn);
    if (!found) throw new Error(`station ${cfg.stationSn} is not in this account`);
    return found;
  }
  const stations = devices.filter(isStation);
  if (stations.length === 1) {
    log(`station: auto-detected ${stations[0].sn} (${stations[0].model ?? "HomeBase"})`);
    return stations[0];
  }
  if (!stations.length) throw new Error("no HomeBase found in this account — set `stationSn` in config.json");
  const list = stations.map((station) => `${station.sn} (${station.model ?? "?"})`).join(", ");
  throw new Error(`several HomeBases found: ${list} — set \`stationSn\` in config.json`);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
/**
 * Opens (or reopens) the P2P session and waits for the level-2 handshake: without it the HomeBase
 * ignores database queries. A long download series kills the session, so `recover` calls this again.
 *
 * @param {Record<string, any>} ctx
 */
async function attachStation(ctx) {
  try {
    await ctx.session?.close();
  } catch {
    /* the old session is already gone */
  }
  await ctx.eufy.connectStation(ctx.station.sn).catch(() => {});
  const session = ctx.eufy.getP2pSessions().get(ctx.station.sn);
  if (!session) throw new Error("no P2P session to the HomeBase");

  const startedAt = Date.now();
  while (Date.now() - startedAt < cfg.level2TimeoutMs && !session.level2Key && !session.level2Ready) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!session.level2Key && !session.level2Ready) throw new Error("level-2 handshake timeout");
  log(`session: level-2 ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  ctx.session = session;
  return session;
}

/**
 * Connects with a few attempts. The station occasionally ignores a connection that follows another run
 * too closely, which shows up as a level-2 handshake timeout.
 */
async function attachWithRetry(ctx, attempts = 3, delayMs = 15000) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await attachStation(ctx);
    } catch (error) {
      if (attempt >= attempts) throw error;
      const wait = Math.round(delayMs / 1000);
      log(`session: ${String(error?.message ?? error).slice(0, 120)} — retrying in ${wait}s (${attempt}/${attempts - 1})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function openSession() {
  const creds = loadCreds(cfg.credentialsFile);
  // Keep and reuse the session: logging in on every run hits eufy's login limit ("Hit max login limit").
  // With a stored token, `login()` skips the /passport/login round trip entirely.
  const eufy = new EufyMega({
    ...creds,
    autoRealtime: false,
    store: new FileSessionStore(sessionFile(cfg.stateDir)),
  });
  try {
    await eufy.login();
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/max login limit/i.test(message)) {
      dropSession(cfg.stateDir);
      throw new Error(`eufy login limit reached (${message.slice(0, 120)}) — wait a while and try again later`);
    }
    throw error;
  }
  try {
    chmodSync(sessionFile(cfg.stateDir), 0o600);
  } catch {
    /* no session file yet on a first, store-less login */
  }
  const station = pickStation(await eufy.getDevices());
  const admin = station.raw?.member?.admin_user_id ?? "";
  const ctx = { eufy, station, admin, session: undefined };
  await attachWithRetry(ctx);
  log(`session: connected to ${station.sn}`);
  return ctx;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------
/**
 * Pages through the recording list, newest first, deduplicated on `record_id` (the HomeBase returns
 * every row twice per reply).
 *
 * @param {Record<string, any>} ctx
 */
async function buildIndex(ctx, { frontier = "" } = {}) {
  const byId = new Map();
  let cursor = "0";
  let reconnects = 0;
  for (let page = 1; page <= 500; page++) {
    let rows = [];
    for (let attempt = 1; ; attempt++) {
      try {
        const reply = await ctx.session.queryRecordPage({
          accountId: ctx.admin,
          startDate: "20150101",
          endDate: "20991231",
          startTime: cursor,
          count: cfg.pageSize,
        });
        rows = (reply ?? []).flatMap((group) => group.payload ?? []).map((row) => row.history ?? row);
        break;
      } catch (error) {
        // Never truncate silently: half an index reports "nothing to do" while thousands of recordings
        // are still pending. Retry the page, then fail the index loudly.
        const reason = String(error?.message ?? error).slice(0, 120);
        if (attempt >= 3) throw new Error(`incomplete index: page ${page} failed (${reason})`);
        // The station answers "sent no complete history_record_info" at random pages, and a fresh
        // session usually fixes it. Reconnecting here — instead of restarting the whole walk — keeps the
        // pages already collected: the cursor is stateless, so resuming at the same page is safe.
        if (attempt >= 2 && reconnects < MAX_INDEX_RECONNECTS) {
          reconnects++;
          log(`index: page ${page} failed (${reason}) — reconnecting (${reconnects}/${MAX_INDEX_RECONNECTS})`);
          try {
            await attachStation(ctx);
            continue;
          } catch (reconnectError) {
            log(`index: reconnect failed (${String(reconnectError?.message ?? reconnectError).slice(0, 120)})`);
          }
        }
        log(`index: page ${page} failed (${reason}) — retrying`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    }
    for (const row of rows) if (row?.record_id != null && !byId.has(row.record_id)) byId.set(row.record_id, row);
    if (!rows.length) break;
    const oldest = rows.map((row) => String(row.start_time ?? "")).sort()[0];
    const next = toCursor(oldest);
    if (!next || next === cursor) {
      log("index: cursor stalled — stopping");
      break;
    }
    // Stop as soon as the pages reach rows an earlier run already decided on. The frontier only ever
    // covers rows with a decision, so this cannot skip history that still has to be archived — during a
    // backfill it sits near the oldest pending row and the index still pages all the way down.
    if (reachedKnownTerritory({ pageOldest: next, frontier })) {
      log(`index: reached decided rows at ${next} after ${page} pages — stopping`);
      break;
    }
    cursor = next;
    if (page % 10 === 0) log(`index: ${byId.size} recordings after ${page} pages`);
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return [...byId.values()].sort((a, b) => String(b.start_time).localeCompare(String(a.start_time)));
}

/** How many times one index walk may reconnect before giving up. */
const MAX_INDEX_RECONNECTS = 8;

// ---------------------------------------------------------------------------
// Download and write
// ---------------------------------------------------------------------------
/** Failure reasons that will never change for a given row, so retrying it is pointless. */
const PERMANENT_REASONS = new Set(["key-unavailable", "invalid-recording"]);

/**
 * Resolves the recording-download callable for a station channel.
 *
 * The download lives on the camera's capability surface — `device.camera().downloadRecording()` — and
 * that member is built when the device is bound. Binding asks whether the camera's parent station is a
 * T8010, and the P2P layer can only answer that once the device list is loaded. So `getDevices()` has to
 * run before `getDevice()`: called the other way round the member is simply absent.
 */
async function downloadFor(ctx, channel) {
  ctx.cameras ??= (await ctx.eufy.getDevices()).filter(
    (device) =>
      device.deviceClass === "camera" &&
      (device.stationSn === ctx.station.sn || device.raw?.parent_sn === ctx.station.sn),
  );
  const camera =
    ctx.cameras.find((device) => device.channel === channel) ??
    (ctx.cameras.length === 1 ? ctx.cameras[0] : undefined);
  if (!camera) throw new Error(`no camera on channel ${channel} of station ${ctx.station.sn}`);

  ctx.devices ??= new Map();
  if (!ctx.devices.has(camera.sn)) ctx.devices.set(camera.sn, await ctx.eufy.getDevice(camera.sn));
  const device = ctx.devices.get(camera.sn);
  const capability = typeof device.camera === "function" ? device.camera() : undefined;
  if (typeof capability?.downloadRecording !== "function") {
    throw new Error(`camera ${camera.sn} does not offer recording download in this SDK version`);
  }
  return capability.downloadRecording;
}

/** Downloads one recording and returns the decrypted elementary streams. */
async function fetchClip(ctx, row) {
  const storagePath = String(row.storage_path ?? "");
  const channel = channelOf(storagePath);
  const recording = recordingName(storagePath);
  if (!storagePath || channel === undefined || !recording) throw new Error(`unusable storage_path: ${storagePath}`);
  // The cloud masks the cipher id; only the low byte resolves to a key record.
  const cipher = (Number(row.cipher_id) || 0) & 0xff;
  const download = await downloadFor(ctx, channel);
  try {
    // The SDK queues downloads per station (one transfer at a time on the camera's channel), fetches the
    // cipher's ECC key, decrypts and returns H.264/AAC elementary streams.
    const clip = await download({ recording, cipherId: cipher, timeoutMs: cfg.clipTimeoutMs });
    return { clip, cipher, channel };
  } catch (error) {
    if (error instanceof RecordingDownloadError && PERMANENT_REASONS.has(error.reason)) error.permanent = true;
    throw error;
  }
}

/** Writes the streams as MP4 (ffmpeg) or, when muxing is impossible, as raw elementary streams. */
function writeClip(row, clip) {
  const { dir, target: initialTarget } = clipTarget({
    outDir: cfg.outDir,
    start: row.start_time,
    recordId: row.record_id,
    exists: existsSync,
  });
  mkdirSync(dir, { recursive: true });
  let target = initialTarget;

  // Temporary files live in the target directory itself: state and output are often on different
  // filesystems (btrfs subvolumes, bind mounts), where a rename fails with EXDEV.
  const tmpBase = path.join(dir, `.tmp-${row.record_id}`);
  const tmpVideo = `${tmpBase}.h264`;
  writeFileSync(tmpVideo, clip.video);
  const tmpAudio = clip.audio ? `${tmpBase}.aac` : undefined;
  if (tmpAudio) writeFileSync(tmpAudio, clip.audio);

  /** Moves within the target directory; falls back to copy+unlink across a filesystem boundary. */
  const move = (from, to) => {
    try {
      renameSync(from, to);
    } catch (error) {
      if (error?.code !== "EXDEV") throw error;
      copyFileSync(from, to);
      rmSync(from, { force: true });
    }
  };

  let format = "mp4";
  try {
    const ffArgs = ["-y", "-loglevel", "error", "-f", "h264", "-i", tmpVideo];
    if (tmpAudio) ffArgs.push("-f", "aac", "-i", tmpAudio);
    ffArgs.push("-c", "copy", "-movflags", "+faststart", "-f", "mp4", `${target}.part`);
    const done = spawnSync(cfg.ffmpeg, ffArgs, { encoding: "utf8" });
    if (done.status !== 0) {
      throw new Error(`ffmpeg: ${String(done.stderr ?? done.error ?? "unknown error").trim().slice(0, 300)}`);
    }
    move(`${target}.part`, target);
  } catch (error) {
    // No usable muxer, or muxing failed: keep the raw streams so the recording is not lost.
    log(`note: muxing failed (${String(error?.message ?? error).slice(0, 200)}) — raw streams kept`);
    format = "h264";
    const rawVideo = target.replace(/\.mp4$/, ".h264");
    move(tmpVideo, rawVideo);
    if (tmpAudio) move(tmpAudio, rawVideo.replace(/\.h264$/, ".aac"));
    target = rawVideo;
  } finally {
    if (existsSync(`${target}.part`)) rmSync(`${target}.part`, { force: true });
    for (const file of [tmpVideo, tmpAudio]) if (file && existsSync(file)) rmSync(file, { force: true });
  }
  return { file: path.relative(cfg.outDir, target), format };
}

/**
 * Checks that the muxer can read raw H.264. Some NAS builds ship an ffmpeg without that demuxer; without
 * this check every clip would silently end up as a raw .h264 file instead of an MP4.
 */
function checkMuxer() {
  const done = spawnSync(cfg.ffmpeg, ["-hide_banner", "-demuxers"], { encoding: "utf8" });
  if (done.status !== 0) {
    throw new Error(`muxer ${cfg.ffmpeg} is not runnable: ${String(done.error ?? done.stderr ?? "").trim().slice(0, 160)}`);
  }
  if (!/^\s*D\s+h264\b/m.test(String(done.stdout ?? ""))) {
    throw new Error(`muxer ${cfg.ffmpeg} has no h264 demuxer — point \`ffmpeg\` in config.json at a full build`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!MODE.list && !existsSync(path.dirname(cfg.outDir))) {
    throw new Error(`parent directory of outDir does not exist: ${path.dirname(cfg.outDir)}`);
  }
  if (!acquireLock(cfg.stateDir, { log })) return { ok: 0, failed: 0, skipped: 0, pending: 0 };
  try {
    checkMuxer();
    return await run();
  } finally {
    releaseLock(cfg.stateDir);
  }
}

async function run() {
  const state = loadState(cfg.stateDir);
  const ctx = await openSession();

  const limitLabel = limit === Number.POSITIVE_INFINITY ? "all" : String(limit);
  log(`start: ${MODE.list ? "list mode" : "sync mode"} | station ${ctx.station.sn} | target ${cfg.outDir} | limit ${limitLabel}`);
  // `--force` retries rows anywhere in the history and a `since` filter hides rows, so both need the
  // whole list; otherwise the frontier from the previous run keeps the index to a page or two.
  const fullIndex = MODE.force || MODE.fullIndex || Boolean(since) || !state.frontier;
  const frontier = fullIndex ? "" : String(state.frontier);
  log(fullIndex ? "index: full traversal" : `index: incremental from frontier ${frontier}`);
  const index = await buildIndex(ctx, { frontier });
  writeFileSync(indexFile(cfg.stateDir), JSON.stringify({ at: new Date().toISOString(), count: index.length, rows: index }));
  log(`index: ${index.length} recordings on the HomeBase`);

  const pending = index.filter((row) =>
    isPending(row, state, { since, force: MODE.force, maxAttempts: cfg.maxAttempts }),
  );
  const archived = Object.keys(state.clips).length;
  log(`state: ${archived} archived, ${Object.keys(state.failures).length} failed, ${pending.length} pending`);

  const frontierAfter = nextFrontier({
    previous: String(state.frontier ?? ""),
    oldestPending: pending.length ? toCursor(pending[pending.length - 1].start_time) : "",
    newestSeen: toCursor(index[0]?.start_time),
  });
  if (!since && frontierAfter && frontierAfter !== state.frontier) {
    state.frontier = frontierAfter;
    saveState(cfg.stateDir, state);
  }

  if (MODE.indexOnly) return { ok: 0, failed: 0, skipped: 0, pending: pending.length };

  if (MODE.list) {
    for (const row of pending.slice(0, Math.min(limit, 50))) {
      log(
        `  ${row.start_time}  ${String(row.storage_path).replace("/media/mmcblk0p1/", "")}  cipher ${(Number(row.cipher_id) || 0) & 0xff}`,
      );
    }
    log(`list: ${pending.length} pending, ${limit === Number.POSITIVE_INFINITY ? "no limit" : `limit ${limit}`}`);
    return { ok: 0, failed: 0, skipped: 0, pending: pending.length };
  }

  const batch = pending.slice(0, limit);
  if (!batch.length) {
    log("nothing to do");
    return { ok: 0, failed: 0, skipped: 0, pending: 0 };
  }

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let consecutive = 0;
  let recoveries = 0;
  const startedAt = Date.now();

  for (const row of batch) {
    const label = `${row.start_time} (${String(row.storage_path).split("/").pop()})`;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const { clip } = await fetchClip(ctx, row);
        const written = writeClip(row, clip);
        const full = path.join(cfg.outDir, written.file);
        const bytes = existsSync(full) ? statSync(full).size : 0;
        state.clips[row.record_id] = {
          start: row.start_time,
          file: written.file,
          format: written.format,
          bytes,
          frames: clip.frames,
          missing: clip.missingFrames,
          durationMs: clip.durationMs,
          at: new Date().toISOString(),
        };
        delete state.failures[row.record_id];
        delete state.skipped?.[row.record_id];
        saveState(cfg.stateDir, state);
        ok++;
        consecutive = 0;
        log(
          `ok: ${label} → ${written.file} (${clip.frames} frames, ${clip.missingFrames} missing, ${Math.round(bytes / 1024)} KiB)`,
        );
        break;
      } catch (error) {
        const message = describeError(error).slice(0, 300);

        // Permanently unusable (no key in the cloud): record it as skipped instead of failed, otherwise
        // every run retries the same thousands of recordings and aborts after its retry budget.
        if (error?.permanent) {
          state.skipped[row.record_id] = { start: row.start_time, reason: message, at: new Date().toISOString() };
          delete state.failures[row.record_id];
          saveState(cfg.stateDir, state);
          skipped++;
          consecutive = 0;
          log(`skipped: ${label} → ${message}`);
          break;
        }

        // A series of dozens of downloads kills the P2P session; that does not recover by itself. So
        // after `recoverAfter` consecutive session errors, reconnect and retry the same clip once,
        // instead of abandoning the whole run.
        const sessionish =
          /sent nothing|went quiet|incomplete|ran past|no complete|level-2|disconnect|closed|timed out|timeout/i.test(
            message,
          );
        if (sessionish && attempt === 1 && consecutive + 1 >= cfg.recoverAfter && recoveries < cfg.maxRecoveries) {
          recoveries++;
          log(
            `session: ${consecutive + 1} consecutive errors — reconnecting (recovery ${recoveries}/${cfg.maxRecoveries})`,
          );
          try {
            await attachStation(ctx);
            consecutive = 0;
            continue;
          } catch (recoverError) {
            log(`session: recovery failed (${String(recoverError?.message ?? recoverError).slice(0, 160)})`);
          }
        }

        failed++;
        consecutive++;
        const previous = state.failures[row.record_id];
        state.failures[row.record_id] = {
          start: row.start_time,
          error: message,
          attempts: Number(previous?.attempts ?? 0) + 1,
          at: new Date().toISOString(),
        };
        saveState(cfg.stateDir, state);
        log(`error: ${label} → ${message}`);
        break;
      }
    }
    if (consecutive >= cfg.recoverAfter + 2) {
      log("session keeps failing despite recovery — aborting this run");
      break;
    }
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  log(`run: ${ok} archived, ${failed} failed, ${skipped} skipped in ${Math.round(elapsed / 60)} min`);
  return { ok, failed, skipped, pending: pending.length - batch.length };
}

let result = { ok: 0, failed: 0, skipped: 0, pending: 0 };
let code = 1;
try {
  result = await main();
  code = result.failed === 0 ? 0 : 1;
} catch (error) {
  log(`abort: ${describeError(error).slice(0, 400)}`);
} finally {
  // A stable, single line for wrappers (backfill.sh) to read, whatever the outcome.
  log(`summary: archived=${result.ok} failed=${result.failed} skipped=${result.skipped} pending=${result.pending}`);
}
process.exit(code);
