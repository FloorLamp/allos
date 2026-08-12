import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A restored browser cache must not trigger Playwright's install-deps command.
// install-deps performs a full apt-get update, including unrelated repositories
// configured on GitHub's hosted image; one transient third-party 403 used to kill a
// shard before it ran a single test (#1986). Cache misses still own the complete
// browser + dependency install.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const action = fs.readFileSync(
  path.join(REPO, ".github", "actions", "e2e-setup", "action.yml"),
  "utf8"
);
const seed = fs.readFileSync(
  path.join(REPO, ".github", "workflows", "cache-seed.yml"),
  "utf8"
);

/** The `key:` of the step that caches ~/.cache/ms-playwright, minus indentation. */
function browserCacheKey(workflow: string): string | undefined {
  return workflow
    .split(/\n/)
    .find((l) => l.includes("key: playwright"))
    ?.trim();
}

describe("e2e Playwright cache setup", () => {
  it("installs browser dependencies only on a browser-cache miss", () => {
    expect(action).not.toContain("playwright install-deps");
    expect(action).toMatch(
      /name: Install Playwright Chromium[\s\S]*if: steps\.playwright\.outputs\.cache-hit != 'true'[\s\S]*run: npx playwright install --with-deps( --only-shell)? chromium/
    );
  });

  // The seed workflow populates the very cache e2e-setup restores, and drift
  // between them does NOT fail anything: the seed simply saves under a key
  // nothing looks up, and every PR quietly pays a cold browser install again.
  // Both halves are pinned here because both have to move together — the KEY (or
  // a stale entry restores) and the INSTALL FLAGS (or the entry holds a
  // different set of binaries than the suite launches).
  it("seeds the browser cache under the key e2e-setup restores", () => {
    const actionKey = browserCacheKey(action);
    const seedKey = browserCacheKey(seed);
    expect(actionKey).toBeDefined();
    expect(seedKey).toEqual(actionKey);
  });

  it("seeds the same binaries the suite launches", () => {
    // Headless `browserName: "chromium"` launches chromium_headless_shell, so
    // only the shell is installed and cached — the headed binary was 389 MB of a
    // 651 MB entry, restored on every shard and launched by nothing. If a spec
    // ever needs the headed browser, drop --only-shell in BOTH files and re-key.
    const shellOnly = (w: string): boolean =>
      /playwright install[^\n]*--only-shell[^\n]*chromium/.test(w);
    expect(shellOnly(action)).toBe(shellOnly(seed));
    // ...and the key must say which, so the two shapes can never share an entry.
    expect(browserCacheKey(action)?.includes("playwright-shell-")).toBe(
      shellOnly(action)
    );
  });
});
