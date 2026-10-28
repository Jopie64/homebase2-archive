import { describe, expect, it } from "vitest";
import { option, parseArgs } from "../lib/cli.mjs";

const cfg = { maxClips: 300, since: "" };

describe("option", () => {
  it("reads the spaced form", () => {
    expect(option(["--limit", "2"], "limit", "x")).toBe("2");
  });

  it("reads the inline form", () => {
    expect(option(["--limit=7"], "limit", "x")).toBe("7");
  });

  it("prefers the inline form when both are present", () => {
    expect(option(["--limit=7", "--limit", "2"], "limit", "x")).toBe("7");
  });

  it("falls back when the flag is absent", () => {
    expect(option(["--list"], "limit", "x")).toBe("x");
  });

  it("falls back when the flag has no value", () => {
    expect(option(["--limit"], "limit", "x")).toBe("x");
  });

  it("does not consume the next flag as a value", () => {
    expect(option(["--limit", "--all"], "limit", "x")).toBe("x");
  });
});

describe("parseArgs", () => {
  it("defaults to the configured clip count", () => {
    expect(parseArgs([], cfg).limit).toBe(300);
  });

  it("honours --limit N, the form used throughout the manual", () => {
    expect(parseArgs(["--limit", "2"], cfg).limit).toBe(2);
  });

  it("honours --limit=N", () => {
    expect(parseArgs(["--limit=7"], cfg).limit).toBe(7);
  });

  it("treats --all as unlimited, whatever the limit says", () => {
    expect(parseArgs(["--all", "--limit", "2"], cfg).limit).toBe(Number.POSITIVE_INFINITY);
  });

  it("rejects a non-numeric limit instead of silently archiving nothing", () => {
    expect(() => parseArgs(["--limit", "abc"], cfg)).toThrow(/non-negative number/);
  });

  it("rejects a negative limit", () => {
    expect(() => parseArgs(["--limit=-1"], cfg)).toThrow(/non-negative number/);
  });

  it("strips separators from --since", () => {
    expect(parseArgs(["--since", "2026-01-01"], cfg).since).toBe("20260101");
  });

  it("falls back to the configured since date", () => {
    expect(parseArgs([], { maxClips: 1, since: "20250101" }).since).toBe("20250101");
  });

  it("recognises every mode flag", () => {
    const { mode } = parseArgs(["--list", "--force", "--index-only"], cfg);
    expect(mode).toEqual({ list: true, all: false, force: true, indexOnly: true });
  });
});
