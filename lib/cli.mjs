/**
 * cli.mjs — argument parsing, kept separate so it can be tested.
 */
/**
 * Reads a `--name value` or `--name=value` option. Both forms must work: the manual uses the spaced
 * form, and a parser that only understands `--name=value` silently ignores it (that was a real bug).
 *
 * @param {string[]} args
 * @param {string} name
 * @param {string} fallback
 */
export function option(args, name, fallback) {
  const inline = args.find((argument) => argument.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  const next = args[index + 1];
  if (index !== -1 && next && !next.startsWith("--")) return next;
  return fallback;
}

/**
 * @param {string[]} args raw process.argv slice
 * @param {{ maxClips: number, since: string }} cfg
 * @returns {{ mode: { list: boolean, all: boolean, force: boolean, indexOnly: boolean, fullIndex: boolean },
 *             limit: number, since: string }}
 */
export function parseArgs(args, cfg) {
  const flag = (name) => args.includes(`--${name}`);
  const mode = {
    list: flag("list"),
    all: flag("all"),
    force: flag("force"),
    indexOnly: flag("index-only"),
    fullIndex: flag("full-index"),
  };
  const rawLimit = option(args, "limit", String(cfg.maxClips));
  const limit = mode.all ? Number.POSITIVE_INFINITY : Number(rawLimit);
  if (Number.isNaN(limit) || limit < 0) {
    throw new Error(`--limit must be a non-negative number (got ${JSON.stringify(rawLimit)})`);
  }
  return {
    mode,
    limit,
    since: String(option(args, "since", cfg.since)).replace(/\D/g, ""),
  };
}
