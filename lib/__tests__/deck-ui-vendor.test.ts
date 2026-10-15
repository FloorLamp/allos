// scripts/deck-ui.mjs vendors Deck's web UI only when every download is its sha256, in
// the channel's index and in the manifest; anything else leaves the tree untouched.
// A made-up channel served from memory.

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { vendor } from "../../scripts/deck-ui.mjs";
import { makeTmpDir } from "./tmp-dir";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function channel(tamper: boolean) {
  const js = "export const x = 1;\n";
  const manifest = JSON.stringify({
    version: "0.1.1",
    revision: "a".repeat(40),
    hostApi: 1,
    files: { "ui/src/mount.js": sha(js) },
  });
  const served = new Map<string, string>([
    ["https://hangar.test/c/deck-ui/", ""],
    [`https://hangar.test/${sha(manifest)}.json`, manifest],
    [
      `https://hangar.test/${sha(js)}.js`,
      tamper ? "export const x = 2;\n" : js,
    ],
  ]);
  served.set(
    "https://hangar.test/c/deck-ui/",
    JSON.stringify({
      files: {
        "manifest-0.1.1.json": {
          sha256: sha(manifest),
          url: `https://hangar.test/${sha(manifest)}.json`,
        },
        [sha(js)]: {
          sha256: sha(js),
          url: `https://hangar.test/${sha(js)}.js`,
        },
      },
    })
  );
  const fetch = (async (url: URL) => {
    const body = served.get(String(url));
    return body === undefined
      ? new Response("", { status: 404 })
      : new Response(body);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, channel: "https://hangar.test/c/deck-ui/" };
}

function checkout(): string {
  const root = makeTmpDir("deck-ui");
  mkdirSync(join(root, "lib"));
  return root;
}

describe("vendoring Deck's web UI", () => {
  it("writes the version and its pin when every file is its sha256", async () => {
    const root = checkout();
    const pin = await vendor("0.1.1", { root, ...channel(false) });
    expect(pin.version).toBe("0.1.1");
    expect(
      readFileSync(join(root, "public/deck-ui/0.1.1/ui/src/mount.js"), "utf8")
    ).toBe("export const x = 1;\n");
    expect(existsSync(join(root, "lib/deck-ui-pin.json"))).toBe(true);
  });

  it("refuses a download that is not its sha256 and writes nothing", async () => {
    const root = checkout();
    await expect(vendor("0.1.1", { root, ...channel(true) })).rejects.toThrow(
      /not its sha256/
    );
    expect(existsSync(join(root, "public/deck-ui/0.1.1"))).toBe(false);
    expect(existsSync(join(root, "lib/deck-ui-pin.json"))).toBe(false);
  });
});
