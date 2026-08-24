import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { stripComments } from "./strip-comments";

// THE EVENT-LEDGER SEAM (#3484 part 2).
//
// The owner's ruling draws one line: "the frame is shared, the contracts are not."
// `components/ledger/` is the frame — the date-range control, the chip axis, the item
// filter, the backfill SLOT, the window note, the empty state and the pager. Every
// domain mounts it with its own rows, its own write actions and its own sentences: the
// dose amend rules (#2228), each domain's plausibility gates, each domain's undo
// contract.
//
// That line is easy to write and easy to erode. The erosion is always the same move —
// one `if (kind === "medication")` in the shell, because it is three lines there and
// a refactor in the mount — and after two of them the shared frame is a switchboard
// with a shared name. Nothing about the tree would look wrong; every gate would stay
// green. So the seam is measured here rather than described in a comment, from BOTH
// sides:
//
//   • the shell may not KNOW a domain — not by import, not by vocabulary;
//   • a mount may not REBUILD the frame's parts beside it.
//
// The recognizers are exercised against source authored to break them (the
// `pager-idiom` precedent): a scan that has only ever seen a complying tree is a scan
// nobody has checked can see anything.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SHELL_DIR = "components/ledger";
const FRAME = "components/ledger/EventLedgerFrame.tsx";

// The frame's own parts. A mount that imports one of these is building a second frame
// beside the shared one — which is exactly how the bespoke shell this replaced came
// to exist.
const FRAME_PARTS = [
  "@/components/BackLink",
  "@/components/DateRangeControl",
  "@/components/FilterPills",
  "@/components/PaginationControls",
  "@/components/ledger/EventLedgerItemFilter",
];

// EVERY module the shell may import, named one by one rather than filtered by a
// pattern. An addition here is a deliberate act with a reviewer attached, which is the
// point: the shell's dependency list IS the statement of what a frame is allowed to
// know about.
const SHELL_MAY_IMPORT = new Set([
  "react",
  "next/navigation",
  "@/components/BackLink",
  "@/components/DateRangeControl",
  "@/components/FilterPills",
  "@/components/PaginationControls",
  "@/components/ledger/EventLedgerItemFilter",
  "@/components/ui",
  "@/lib/hrefs",
  "@/lib/timeline-format",
]);

// The domains that log events. A shell that says any of these words in CODE is
// answering a question that belongs to one mount.
const DOMAIN_WORDS = [
  "dose",
  "medication",
  "supplement",
  "intake",
  "administration",
  "food",
  "meal",
  "nutrition",
  "serving",
  "practice",
  "substance",
  "workout",
  "symptom",
];

// Comments are STRIPPED before the vocabulary scan, and that is not a loophole — it is
// the difference between the shell knowing a domain and the shell explaining itself.
// The frame's own header names the dose ledger as the shape it was extracted from, and
// forbidding that would make the file harder to read for no gain in the seam.
//
// Through the shared scanner (#3595), which reads the file in order tracking what it is
// inside, rather than through the pair of regexes this file first hand-rolled: block
// comments stripped first means a `/*` written inside a `//` sentence swallows every
// line to the next unrelated `*/`, and a scan that silently loses source is a scan that
// passes for the wrong reason. String literals survive it, which is what the
// "reads comments and code differently" case below turns on.

function importsOf(text: string): string[] {
  return [...text.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
}

function domainWordsIn(text: string): string[] {
  const code = stripComments(text);
  return DOMAIN_WORDS.filter((word) =>
    new RegExp(`\\b${word}s?\\b`, "i").test(code)
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts"))
      out.push(full);
  }
  return out;
}

function rel(full: string): string {
  return path.relative(REPO, full).split(path.sep).join("/");
}

const SHELL_FILES = walk(path.join(REPO, SHELL_DIR)).map((full) => ({
  rel: rel(full),
  text: fs.readFileSync(full, "utf8"),
}));

const APP_FILES = ["app", "components"]
  .flatMap((dir) => walk(path.join(REPO, dir)))
  .map((full) => ({ rel: rel(full), text: fs.readFileSync(full, "utf8") }))
  // The shell is scanned by the block above, and `__tests__` is not app source — the
  // hazard docs/internals/component-tests.md names, where a scanner walking
  // `components/` trips over a fixture that was never a page.
  .filter(
    (f) => !f.rel.startsWith(`${SHELL_DIR}/`) && !f.rel.includes("__tests__")
  );

describe("the shell does not know a domain", () => {
  it("has files at all, so every claim below is about something", () => {
    // The scan's own premise. An empty directory satisfies every assertion here.
    expect(SHELL_FILES.map((f) => f.rel).sort()).toEqual([
      "components/ledger/EventLedgerFrame.tsx",
      "components/ledger/EventLedgerItemFilter.tsx",
    ]);
  });

  it("imports only the modules a frame is allowed to know", () => {
    const offenders = SHELL_FILES.flatMap((f) =>
      importsOf(f.text)
        .filter((spec) => !SHELL_MAY_IMPORT.has(spec))
        .map((spec) => `${f.rel} imports ${spec}`)
    );
    expect(
      offenders,
      "The event-ledger shell reached outside the frame. A domain's reader, its " +
        "Server Actions and its row types belong in the MOUNT " +
        "(components/intake/DoseLedgerMount.tsx is the worked example). If this is " +
        "genuinely a new shared primitive, add it to SHELL_MAY_IMPORT and say why in " +
        "the review."
    ).toEqual([]);
  });

  it("says no domain's vocabulary in code", () => {
    const offenders = SHELL_FILES.map((f) => ({
      rel: f.rel,
      words: domainWordsIn(f.text),
    }))
      .filter((f) => f.words.length > 0)
      .map((f) => `${f.rel} — ${f.words.join(", ")}`);
    expect(
      offenders,
      "The event-ledger shell named a domain in its code. This is the erosion the " +
        "seam exists to stop: a kind-specific branch, label or test id in the frame " +
        "is that domain's second implementation wearing a shared name. Move it into " +
        "the mount, which supplies the frame with finished strings and finished rows."
    ).toEqual([]);
  });
});

describe("a mount does not rebuild the frame", () => {
  const mounts = APP_FILES.filter((f) =>
    importsOf(f.text).includes(`@/${FRAME.replace(/\.tsx$/, "")}`)
  );

  it("mounts the frame exactly where the ruling says", () => {
    // Deliberately a list. #3484 part 3 adds the food and practices mounts, and part 1
    // adds nothing here — so a new entry should be an edit somebody made on purpose.
    expect(mounts.map((f) => f.rel).sort()).toEqual([
      "components/intake/DoseLedgerMount.tsx",
    ]);
  });

  it("reaches the frame's parts only through the frame", () => {
    const offenders = mounts.flatMap((f) =>
      importsOf(f.text)
        .filter((spec) => FRAME_PARTS.includes(spec))
        .map((spec) => `${f.rel} imports ${spec}`)
    );
    expect(
      offenders,
      "A ledger mount imported one of the frame's own parts. The frame places the " +
        "back link, the range control, the chips, the item filter and the pager; a " +
        "mount that renders one itself has forked the frame at that part, and the " +
        "next fix to it lands on only one ledger."
    ).toEqual([]);
  });

  it("leaves the frame as the app's only date-ranged, paged chassis", () => {
    // The bespoke shell this replaced was recognisable by exactly this pair. Nothing
    // else in the app pages a date-ranged list; a second file that did would be that
    // shell coming back under another name.
    const both = APP_FILES.concat(SHELL_FILES).filter((f) => {
      const specs = importsOf(f.text);
      return (
        specs.includes("@/components/DateRangeControl") &&
        specs.includes("@/components/PaginationControls")
      );
    });
    expect(both.map((f) => f.rel)).toEqual([FRAME]);
  });
});

describe("the recognizers can see", () => {
  // Every scan above, run against source written to break it. Without these, a typo in
  // a pattern is indistinguishable from a clean tree.
  it("sees a domain branch in the shell", () => {
    expect(
      domainWordsIn(`
        const label = kind === "medication" ? "Log past dose" : "Log";
      `)
    ).toEqual(["dose", "medication"]);
  });

  it("sees a domain import in the shell", () => {
    const specs = importsOf(
      `import { deleteAdministration } from "@/app/(app)/nutrition/intake-actions";`
    ).filter((spec) => !SHELL_MAY_IMPORT.has(spec));
    expect(specs).toEqual(["@/app/(app)/nutrition/intake-actions"]);
  });

  it("sees a frame part imported beside the frame", () => {
    const specs = importsOf(
      `import DateRangeControl from "@/components/DateRangeControl";`
    ).filter((spec) => FRAME_PARTS.includes(spec));
    expect(specs).toEqual(["@/components/DateRangeControl"]);
  });

  it("reads comments and code differently, in both directions", () => {
    // The stripping is what lets the frame explain where it came from. It must not
    // also let a branch hide behind a `//`.
    expect(
      domainWordsIn(`// the dose ledger was the first mount\nconst a = 1;`)
    ).toEqual([]);
    expect(domainWordsIn(`/* dose */ const a = 1;`)).toEqual([]);
    expect(domainWordsIn(`const a = "dose"; // nothing`)).toEqual(["dose"]);
    // A URL in a string keeps its slashes rather than swallowing the rest of the line.
    expect(
      stripComments(`const u = "https://example.test/dose";`).includes("dose")
    ).toBe(true);
    // And a `/*` inside a line comment does not eat the code beneath it. The
    // hand-rolled pair of regexes this scan started with strips BLOCK comments first,
    // so the `/*` below opened a comment that ran to the next unrelated `*/` and took
    // the line between them with it — the #3595 failure, in three lines.
    expect(
      domainWordsIn(
        `// see components/x/*: notes\nconst a = "dose";\n/* trailing */`
      )
    ).toEqual(["dose"]);
  });
});
