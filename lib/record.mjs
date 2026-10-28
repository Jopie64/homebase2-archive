/**
 * record.mjs — the pure rules about station rows and output files.
 *
 * Kept free of I/O so the decisions that shaped the archiver (which rows are usable, which are still
 * pending, how a clip is named) are testable without a HomeBase.
 */
import path from "node:path";

/** The station's recording name: `h265_<yyyymmddhhmmss>.dat`. */
const RECORDING_PATH = /h265_\d{14}\.dat$/;

/** Normalises a station timestamp to the 14-digit cursor form (`yyyyMMddHHmmss`). */
export const toCursor = (value) => String(value ?? "").replace(/\D/g, "").slice(0, 14);

/** The recording name inside a storage path: `h265_20261028125700.dat`. */
export const recordingName = (storagePath) => path.basename(String(storagePath ?? ""));

/** Channel number from a storage path like `/media/mmcblk0p1/Camera00/h265_...dat`. */
export const channelOf = (storagePath) => {
  const match = /Camera(\d+)/.exec(String(storagePath ?? ""));
  return match ? Number(match[1]) : undefined;
};

/**
 * Whether a row can be downloaded at all: it needs a full recording path and at least one frame.
 *
 * @param {Record<string, any>} row
 * @param {{ since?: string }} [options]
 */
export function isUsable(row, { since = "" } = {}) {
  if (!RECORDING_PATH.test(String(row?.storage_path ?? ""))) return false;
  if (!(Number(row?.frame_num) > 0)) return false;
  if (since && toCursor(row.start_time) < since) return false;
  return true;
}

/**
 * Whether a row still has to be archived: usable, not archived yet, and not given up on.
 *
 * @param {Record<string, any>} row
 * @param {{ clips?: object, failures?: object, skipped?: object }} state
 * @param {{ since?: string, force?: boolean, maxAttempts?: number }} [options]
 */
export function isPending(row, state, { since = "", force = false, maxAttempts = 3 } = {}) {
  if (!isUsable(row, { since })) return false;
  if (state.clips?.[row.record_id]) return false;
  if (state.skipped?.[row.record_id] && !force) return false;
  const failure = state.failures?.[row.record_id];
  if (failure && !force && Number(failure.attempts ?? 0) >= maxAttempts) return false;
  return true;
}

/**
 * Where a recording is written: `<dir>/<yyyy-mm-dd>_<hh-mm-ss>.mp4`, with a short id suffix when that
 * name is already taken (two recordings in the same second).
 *
 * @param {{ outDir: string, start?: string, recordId: string | number, exists?: (file: string) => boolean }} options
 */
export function clipTarget({ outDir, start, recordId, exists = () => false }) {
  const stampSource = String(start ?? "");
  const day = stampSource.slice(0, 10) || "unknown";
  const month = day.slice(0, 7) || "unknown";
  const dir = path.join(outDir, month);
  const time = stampSource.slice(11, 19).replace(/:/g, "-");
  const stamp = time ? `${day}_${time}` : day;
  const base = path.join(dir, `${stamp}${stampSource.length ? "" : `_${recordId}`}`);
  let target = `${base}.mp4`;
  if (exists(target)) target = `${base}_${String(recordId).slice(-6)}.mp4`;
  return { dir, month, day, stamp, target };
}
