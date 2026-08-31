import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { makeTmpDir } from "./tmp-dir";
import { buildSnapshot } from "../../scripts/orchestration/queue-snapshot.mjs";
import { WATERMARK_ISSUE_TITLE } from "../../scripts/orchestration/reconcile-tracker-core";

// THE WRITTEN-DOWN QUEUE (owner, 2026-08-31). A live session with open
// capacity called the queue thin while four dispatchable items sat in it —
// candidates get forgotten one at a time when the queue lives in the
// orchestrator's head. What is pinned here: which items the sweep keeps and
// drops (and WHY each exclusion is the runbook's, not a guess), the order
// that puts owner-filed work first, and that running the script writes the
// file the check-in cites.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCRIPT = path.join(REPO, "scripts/orchestration/queue-snapshot.mjs");

const NOW = new Date("2026-08-31T12:00:00Z");
const issue = (
  number: number,
  labels: string[],
  over: Partial<{ title: string; body: string; pull_request: unknown }> = {}
) => ({
  number,
  title: over.title ?? `issue ${number}`,
  body: over.body ?? "",
  labels: labels.map((name) => ({ name })),
  ...(over.pull_request ? { pull_request: over.pull_request } : {}),
});

describe("buildSnapshot", () => {
  it("keeps candidates and drops exactly the runbook's exclusions", () => {
    const { rows } = buildSnapshot(
      [
        issue(1, ["P2", "db"]),
        issue(2, ["parked", "design"]), // parked is not queue state
        issue(3, ["needs-human", "P1", "ui"]), // owner-gated
        issue(4, ["P1"], { pull_request: {} }), // a PR, not an issue
        issue(5, ["infra", "parked"], { title: WATERMARK_ISSUE_TITLE }),
        issue(6, ["ui"]), // no slot — hygiene drift, still work
      ],
      NOW
    );
    expect(rows.map((r) => r.number)).toEqual([1, 6]);
  });

  it("orders by slot, free before under-dispatch, oldest first — [no-slot] last", () => {
    const { rows, text } = buildSnapshot(
      [
        issue(10, ["P2", "db"]),
        issue(11, ["P1", "ui"]),
        issue(12, ["P2", "ui"]),
        issue(13, ["ui"]),
      ],
      NOW,
      new Map([[12, "some-lane"]])
    );
    expect(rows.map((r) => r.number)).toEqual([11, 10, 12, 13]);
    expect(text).toContain("P2 #12 [lane:some-lane]");
    expect(text).toContain("[no-slot] #13");
  });

  it("carries Depends-on as an unmissable marker, unresolved", () => {
    const { text } = buildSnapshot(
      [issue(20, ["P2", "ui"], { body: "Depends-on: #4076\nrest of body" })],
      NOW
    );
    expect(text).toContain("P2 #20 [deps:#4076]");
  });

  it("the header states the count and what a 'thin' claim owes", () => {
    const { text } = buildSnapshot([issue(1, ["P2", "db"])], NOW);
    expect(text.split("\n")[0]).toContain("1 candidates as of 2026-08-31");
    expect(text).toContain("a 'thin' claim answers every line here");
  });

  it("pins the carrier-title literal to the core's constant", () => {
    // The script cannot import the TypeScript core under plain node, so it
    // carries the title as a literal; a rename must break HERE.
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source).toContain(`"${WATERMARK_ISSUE_TITLE}"`);
  });
});

describe("queue-snapshot.mjs, driven as a script", () => {
  it("writes $SCRATCH/.queue from the swept issues", () => {
    const dir = makeTmpDir("queue-snapshot");
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "curl"),
      `#!${process.execPath}\n` +
        `process.stdout.write(JSON.stringify([{number: 7, title: "a candidate", body: "", labels: [{name: "P1"}, {name: "db"}]}]));\n`,
      { mode: 0o755 }
    );
    const run = spawnSync(process.execPath, [SCRIPT], {
      cwd: REPO,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_TOKEN: "stub token 1",
        SCRATCH: dir,
      },
    });
    expect(run.status).toBe(0);
    const written = fs.readFileSync(path.join(dir, ".queue"), "utf8");
    expect(written).toContain("1 candidates");
    expect(written).toContain("P1 #7 a candidate");
    expect(run.stdout).toBe(written);
  });
});

// THE LEDGER CROSS-REFERENCE (#4451). The sweep listed issues under active
// dispatch as available capacity — 4 of the 5 issues in active ledger entries
// appeared in the 10:22Z file. The ledger's own parse moved to ledger.mjs
// with #4460 and is pinned in dispatch-ledger.test.ts; what is pinned HERE is
// the half this file owns — a lane it is handed is MARKED, never dropped.
const LANES = new Map([
  [3276, "write-3276"],
  [4118, "nut-4118"],
  [3987, "nut-4118"],
]);

describe("issues under dispatch are MARKED, never dropped", () => {
  const swept = () =>
    buildSnapshot(
      [
        issue(3276, ["P2"]),
        issue(4118, ["P1"]),
        issue(3987, ["P1"]),
        issue(4280, ["P2"]),
        issue(50, ["P2"]),
      ],
      NOW,
      LANES
    );

  it("keeps the row in the file — a dropped row is a forgotten row", () => {
    expect(swept().rows.map((r) => r.number)).toContain(3276);
  });

  it("marks it with the branch that holds it, and counts it in the header", () => {
    const { text } = swept();
    expect(text).toContain("P2 #3276 [lane:write-3276]");
    expect(text.split("\n")[0]).toContain("(3 under dispatch)");
  });

  it("leaves free work unmarked — the marker must discriminate", () => {
    const { text, rows } = swept();
    expect(text).toContain("P2 #4280 issue 4280");
    expect(rows.filter((r) => r.lane).length).toBe(3);
  });

  it("publishes no count it cannot measure — provenance is not phrasing", () => {
    // The old header published `(N self-filed)` from `/found (while|by)/i`
    // over the body: 3 hits in 8 on the only ground-truth set there was.
    const { text } = buildSnapshot(
      [
        issue(1, ["P2"], {
          body: "Found while implementing #7. found by lane X",
        }),
      ],
      NOW
    );
    expect(text).not.toContain("self-filed");
    expect(text).not.toContain("[self]");
  });
});
