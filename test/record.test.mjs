import { describe, expect, it } from "vitest";
import { channelOf, clipTarget, isPending, isUsable, recordingName, toCursor } from "../lib/record.mjs";

const row = (overrides = {}) => ({
  record_id: "123456789",
  start_time: "2026-10-28 12:57:01",
  storage_path: "/media/mmcblk0p1/Camera00/h265_20261028125700.dat",
  frame_num: 154,
  cipher_id: 98,
  ...overrides,
});

const emptyState = () => ({ clips: {}, failures: {}, skipped: {} });

describe("toCursor", () => {
  it("turns a station timestamp into the 14-digit cursor", () => {
    expect(toCursor("2026-10-28 12:57:01")).toBe("20261028125701");
  });

  it("keeps the cursor the station itself accepts", () => {
    expect(toCursor("0")).toBe("0");
    expect(toCursor(20261028125701)).toBe("20261028125701");
  });

  it("never returns more than fourteen digits", () => {
    expect(toCursor("2026-10-28 12:57:01.123456")).toHaveLength(14);
  });

  it("returns an empty string for missing values", () => {
    expect(toCursor(undefined)).toBe("");
  });
});

describe("recordingName", () => {
  it("returns the recording name the station knows", () => {
    expect(recordingName("/media/mmcblk0p1/Camera00/h265_20261028125700.dat")).toBe("h265_20261028125700.dat");
  });

  it("returns an empty string when there is no path", () => {
    expect(recordingName(undefined)).toBe("");
  });
});

describe("channelOf", () => {
  it("reads the channel from the storage path", () => {
    expect(channelOf("/media/mmcblk0p1/Camera00/h265_20261028125700.dat")).toBe(0);
    expect(channelOf("/media/mmcblk0p1/Camera02/h265_20261028125700.dat")).toBe(2);
  });

  it("returns undefined when the path names no channel", () => {
    expect(channelOf("h265_20261028125700.dat")).toBeUndefined();
    expect(channelOf(undefined)).toBeUndefined();
  });
});

describe("isUsable", () => {
  it("accepts a complete row", () => {
    expect(isUsable(row())).toBe(true);
  });

  it("rejects a row without frames", () => {
    expect(isUsable(row({ frame_num: 0 }))).toBe(false);
    expect(isUsable(row({ frame_num: undefined }))).toBe(false);
  });

  it("rejects a path that is not the station's recording name", () => {
    // The bare 14-digit name is what the SDK's own path builder produced: not downloadable as-is.
    expect(isUsable(row({ storage_path: "/media/mmcblk0p1/Camera00/20261028125700" }))).toBe(false);
    expect(isUsable(row({ storage_path: "/media/mmcblk0p1/Camera00/h265_20261028125700" }))).toBe(false);
    expect(isUsable(row({ storage_path: "" }))).toBe(false);
  });

  it("honours the since boundary", () => {
    expect(isUsable(row(), { since: "20260101" })).toBe(true);
    expect(isUsable(row(), { since: "20261029" })).toBe(false);
    expect(isUsable(row(), { since: "20261028" })).toBe(true);
  });
});

describe("isPending", () => {
  it("is pending when nothing is known about the row", () => {
    expect(isPending(row(), emptyState())).toBe(true);
  });

  it("is not pending once archived", () => {
    const state = emptyState();
    state.clips["123456789"] = { file: "2026-10/2026-10-28_12-57-01.mp4" };
    expect(isPending(row(), state)).toBe(false);
  });

  it("is not pending when permanently skipped", () => {
    const state = emptyState();
    state.skipped["123456789"] = { reason: "no ECC key for cipher 1" };
    expect(isPending(row(), state)).toBe(false);
  });

  it("retries skipped rows with --force", () => {
    const state = emptyState();
    state.skipped["123456789"] = { reason: "no ECC key for cipher 1" };
    expect(isPending(row(), state, { force: true })).toBe(true);
  });

  it("gives up on rows that used up their attempts", () => {
    const state = emptyState();
    state.failures["123456789"] = { error: "timed out", attempts: 3 };
    expect(isPending(row(), state, { maxAttempts: 3 })).toBe(false);
    expect(isPending(row(), state, { maxAttempts: 4 })).toBe(true);
  });

  it("retries failed rows with --force", () => {
    const state = emptyState();
    state.failures["123456789"] = { error: "timed out", attempts: 3 };
    expect(isPending(row(), state, { force: true, maxAttempts: 3 })).toBe(true);
  });

  it("skips unusable rows regardless of state", () => {
    expect(isPending(row({ frame_num: 0 }), emptyState())).toBe(false);
  });

  it("copes with a state that has no skipped section yet", () => {
    expect(isPending(row(), { clips: {}, failures: {} })).toBe(true);
  });
});

describe("clipTarget", () => {
  it("writes into a month folder named after the recording", () => {
    const target = clipTarget({ outDir: "/archive", start: "2026-10-28 12:57:01", recordId: "1" });
    expect(target.dir).toBe("/archive/2026-10");
    expect(target.target).toBe("/archive/2026-10/2026-10-28_12-57-01.mp4");
  });

  it("keeps two recordings from the same second apart", () => {
    const target = clipTarget({
      outDir: "/archive",
      start: "2026-10-28 12:57:01",
      recordId: "987654321",
      exists: () => true,
    });
    expect(target.target).toBe("/archive/2026-10/2026-10-28_12-57-01_654321.mp4");
  });

  it("does not use the collision suffix when the name is free", () => {
    const target = clipTarget({
      outDir: "/archive",
      start: "2026-10-28 12:57:01",
      recordId: "987654321",
      exists: () => false,
    });
    expect(target.target).toBe("/archive/2026-10/2026-10-28_12-57-01.mp4");
  });

  it("falls back to an unknown folder for a row without a timestamp", () => {
    const target = clipTarget({ outDir: "/archive", start: "", recordId: "987654321" });
    expect(target.dir).toBe("/archive/unknown");
    expect(target.target).toBe("/archive/unknown/unknown_987654321.mp4");
  });
});
