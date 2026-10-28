/**
 * log.mjs — timestamped logging to stdout and to a rotating file in the state directory.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";

const MAX_BYTES = 5 * 1024 * 1024;

/**
 * @param {{ stateDir: string, fileName?: string }} options
 * @returns {{ log: (message: string) => void, file: string }}
 */
export function createLogger({ stateDir, fileName = "sync.log" }) {
  const file = path.join(stateDir, fileName);
  try {
    mkdirSync(stateDir, { recursive: true });
    // One generation of history is enough; rotate before the first write of a run.
    if (existsSync(file) && statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
  } catch {
    /* logging is best-effort: a read-only state directory must not stop a run */
  }

  const log = (message) => {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    try {
      appendFileSync(file, `${line}\n`);
    } catch {
      /* see above */
    }
  };
  return { log, file };
}
