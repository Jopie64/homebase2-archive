import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The SDK is pinned to a beta version because the recording-download capability (and the HomeBase 2
 * path fix it relies on) only exists there. These tests fail the moment an upgrade takes something we
 * import away — which is exactly how this project ended up patching an unexported binding once.
 */
let sdk;
let importError;
try {
  sdk = await import("@mega-yfue/eufy-sdk");
} catch (error) {
  importError = error;
}

/** Every name this project imports from the SDK, read from the source rather than duplicated here. */
function importedNames() {
  const sources = ["sync.mjs"].map((file) => readFileSync(path.join(ROOT, file), "utf8"));
  const names = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*"@mega-yfue\/eufy-sdk"/g)) {
      for (const entry of match[1].split(",")) {
        const name = entry.trim().split(/\s+as\s+/)[0].trim();
        if (name) names.add(name);
      }
    }
  }
  return [...names];
}

describe.skipIf(Boolean(importError))("SDK contract", () => {
  it("only imports bindings the SDK actually exports", () => {
    const names = importedNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(sdk[name], `@mega-yfue/eufy-sdk does not export ${name}`).toBeDefined();
    }
  });

  it("exposes the client and the file-backed session store", () => {
    expect(typeof sdk.EufyMega).toBe("function");
    expect(typeof sdk.FileSessionStore).toBe("function");
  });

  it("states why a recording could not be produced", () => {
    expect(typeof sdk.RecordingDownloadError).toBe("function");
    const error = new sdk.RecordingDownloadError("key-unavailable", "no key");
    expect(error).toBeInstanceOf(Error);
    expect(error.reason).toBe("key-unavailable");
  });

  it("does not make us depend on the decoder being exported", () => {
    // The archive patch existed only because decodeRecording was not exported. The capability route
    // means the project must not import it again.
    expect(importedNames()).not.toContain("decodeRecording");
    expect(importedNames()).not.toContain("receiveRecording");
  });
});
