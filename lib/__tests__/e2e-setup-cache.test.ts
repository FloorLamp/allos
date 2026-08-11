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

describe("e2e Playwright cache setup", () => {
  it("installs browser dependencies only on a browser-cache miss", () => {
    expect(action).not.toContain("playwright install-deps");
    expect(action).toMatch(
      /name: Install Playwright Chromium[\s\S]*if: steps\.playwright\.outputs\.cache-hit != 'true'[\s\S]*run: npx playwright install --with-deps chromium/
    );
  });
});
