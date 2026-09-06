// A RATCHET ON HAND-ROLLED PAGERS, AND NOTHING ELSE (owner, 2026-09-06).
//
// `components/PaginationControls.tsx` is the app's pager. Three surfaces had
// quietly grown their own copy beside it (#3378), and each copy missed the phone
// shape when the shared component grew one. This file no longer pins the
// recognizer, the mount list, the scan's scope or its silence on benign count
// sentences — it keeps the one number those existed to protect: how many
// surfaces write a pager by hand.
//
// WHAT THIS NO LONGER CATCHES: a WRONG pager, as opposed to a new one. A surface
// rendering `PaginationControls` with the wrong props, a copy written with
// `React.createElement` in a `.ts` file, or a `.tsx` appearing outside `app/`
// and `components/` where the sweep never looks — all pass silently. That cost
// is accepted; the count is the part worth keeping.
//
// N MAY ONLY EVER BE LOWERED, and lowering it belongs to the PR that removes the
// copy. Raising it is how a ratchet becomes a rubber stamp. No allowlist of
// names, no per-file registry.
//
// N = 0, measured on 2b88249b3 with the sweep below: the only `.tsx` under
// `app/` or `components/` writing a pager sentence is PaginationControls itself.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PAGER_HOME = "components/PaginationControls.tsx";

// The two sentences a pager writes, as this repo actually spelled them: the page
// sentence, and the extent as a range (note the en dash).
const PAGER_SENTENCES = [
  /Page\s*\{[^}]+\}\s*of\s*\{/,
  /Showing\s*\{[^}]+\}–\{/,
];

describe("one pager idiom (#3378)", () => {
  it("has not grown a hand-rolled copy", () => {
    const offenders = execFileSync(
      "git",
      // Tracked plus non-ignored untracked: the same boundary that decides what
      // can ship, so a pager added but not yet committed is still counted.
      [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        "app",
        "components",
      ],
      { cwd: REPO, encoding: "utf8" }
    )
      .split("\0")
      .filter(
        (rel) =>
          rel.endsWith(".tsx") &&
          rel !== PAGER_HOME &&
          PAGER_SENTENCES.some((p) =>
            p.test(fs.readFileSync(path.join(REPO, rel), "utf8"))
          )
      );
    expect(offenders.length, offenders.join(", ")).toBeLessThanOrEqual(0);
  });
});
