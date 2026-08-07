import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// One "when" control (issue #2236), ratcheted in the repo's established
// source-scan idiom (`icon-button-tooltip-scan.test.ts`, `page-width-scan.
// test.ts`): read the app's own TSX as TEXT — no DB, no network, so it stays
// "pure" — and fail the build when a NEW raw `<input type="time">` ships
// outside the shared control.
//
// WHY. "When did this happen?" was asked by ten hand-rolled controls in four
// vocabularies, and every one privately re-decided the five behavioural rules
// the question carries (the pair moves together; null means "not stated"; a
// stated time is never seeded from a record stamp; never default to now, offer
// "now"; absolute local times only). `components/WhenControl.tsx` owns those
// rules now, and the raw time input lives THERE and nowhere else.
//
// THE RATCHET. The hand-rolled set below is frozen at its current counts, each
// with the reason it is still allowed. An `event` entry is debt: it migrates to
// the shared control when its surface is touched (#2227/#2228/#2235 are the
// filed first movers), and its count may only SHRINK — shrinking updates the
// entry, growing fails the build. A `plan` entry is out of the control's scope
// on purpose: a notification slot or an appointment time states a PLAN, not an
// observation, so "when did this happen?" is not its question and it is not
// expected to migrate.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const SCAN_DIRS = ["app", "components"];

/** The one legitimate home of a raw event-time input. */
const CONTROL_FILE = "components/WhenControl.tsx";

/** The frozen hand-rolled set: file → { count, kind, reason }. */
const HANDROLLED_ALLOW = new Map<
  string,
  { count: number; kind: "event" | "plan"; reason: string }
>([
  [
    "app/(app)/trends/MeasurementsQuickAdd.tsx",
    {
      count: 2,
      kind: "event",
      reason:
        "temperature + peak flow reading times; #2235 folds both into the " +
        "form's one shared Time control when its occurred_at write half lands",
    },
  ],
  // HistoricalDoseForm.tsx and EpisodeTimeline.tsx left the list with #2228's
  // write half: both adopt the shared control (backfill = state + timeRequired,
  // amend = correct with "Not stated" reachable).
  [
    "components/illness/SymptomLogBar.tsx",
    {
      count: 1,
      kind: "event",
      reason: "temperature reading time on the symptom bar; migrates on touch",
    },
  ],
  [
    "components/practices/LogPracticeButton.tsx",
    {
      count: 1,
      kind: "event",
      reason: "practice session log time; migrates on touch",
    },
  ],
  [
    "components/practices/PracticeSessionHistory.tsx",
    {
      count: 1,
      kind: "event",
      reason: "practice session edit time; migrates on touch",
    },
  ],
  [
    "components/activity-form/DateTimeFields.tsx",
    {
      count: 2,
      kind: "event",
      reason:
        "activity start/end pair — two times sharing one day, a shape the " +
        "control does not model yet; migrates when it grows a range form",
    },
  ],
  [
    "app/(app)/settings/notifications/NotificationPrefs.tsx",
    {
      count: 3,
      kind: "plan",
      reason:
        "notification slot times state a PLAN (a schedule), not an observed " +
        "event — permanently out of the control's scope",
    },
  ],
  [
    "app/(app)/encounters/AppointmentForm.tsx",
    {
      count: 1,
      kind: "plan",
      reason:
        "an appointment time states a PLAN, not an observation — permanently " +
        "out of the control's scope",
    },
  ],
]);

// ── a very small tag reader (the icon-button scan's string/brace skipper) ───

function skipString(s: string, i: number): number {
  const q = s[i];
  i++;
  while (i < s.length) {
    if (s[i] === "\\") i += 2;
    else if (s[i] === q) return i + 1;
    else if (q === "`" && s[i] === "$" && s[i + 1] === "{") {
      i = skipBraces(s, i + 1);
    } else i++;
  }
  return i;
}

function skipBraces(s: string, i: number): number {
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '"' || c === "'" || c === "`") i = skipString(s, i);
    else if (c === "/" && s[i + 1] === "/") {
      const nl = s.indexOf("\n", i);
      i = nl === -1 ? s.length : nl;
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i);
      i = end === -1 ? s.length : end + 2;
    } else {
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return i + 1;
      }
      i++;
    }
  }
  return i;
}

/**
 * Every `<input …>` opening tag whose attributes carry `type="time"`, as line
 * numbers. Attribute values may span lines and contain braces/templates (an
 * onChange arrow's `=>` must not read as the tag's `>`), and a tag mentioned
 * inside a comment is not a tag — both handled by real tokenizing rather than
 * a regex.
 */
export function rawTimeInputs(text: string): number[] {
  const out: number[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(text, i);
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (c === "<" && text.startsWith("<input", i) && !/\w/.test(text[i + 6])) {
      const start = i;
      let j = i + 6;
      let attrs = "";
      let closed = false;
      while (j < text.length) {
        const a = text[j];
        if (a === '"' || a === "'" || a === "`") {
          const end = skipString(text, j);
          attrs += text.slice(j, end);
          j = end;
        } else if (a === "{") {
          j = skipBraces(text, j);
        } else if (a === ">") {
          closed = true;
          j++;
          break;
        } else {
          attrs += a;
          j++;
        }
      }
      if (closed && /(?:^|\s)type\s*=\s*"time"/.test(attrs)) {
        out.push(text.slice(0, start).split("\n").length);
      }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function scanRepo(): Map<string, number[]> {
  const found = new Map<string, number[]>();
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      const lines = rawTimeInputs(fs.readFileSync(full, "utf8"));
      if (lines.length > 0) found.set(rel, lines);
    }
  }
  return found;
}

const HOW = [
  'A raw <input type="time"> asks "when did this happen?" without the shared',
  "rules that question carries. Render <WhenControl> (components/WhenControl",
  '.tsx) instead — it owns the date+time pair, the null = "not stated" value,',
  'the never-default-to-now rule and the one-tap "now". A time that states a',
  'PLAN rather than an observation may be allowlisted here as kind: "plan",',
  "with the reason said.",
].join("\n");

describe('raw <input type="time"> ratchet (issue #2236)', () => {
  const found = scanRepo();

  it("the shared control itself renders one — the scan is not silently empty", () => {
    expect(found.get(CONTROL_FILE)).toHaveLength(1);
  });

  it("every raw time input outside the control is a frozen, reasoned entry", () => {
    const offenders: string[] = [];
    for (const [rel, lines] of found) {
      if (rel === CONTROL_FILE) continue;
      const allowed = HANDROLLED_ALLOW.get(rel);
      if (!allowed) {
        offenders.push(`${rel}:${lines.join(",")} — not in HANDROLLED_ALLOW`);
      } else if (lines.length > allowed.count) {
        offenders.push(
          `${rel} grew: ${lines.length} raw time inputs, allowlisted at ` +
            `${allowed.count} — the count only shrinks`
        );
      }
    }
    expect(offenders, `${HOW}\n\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the allowlist counts are current — a migrated surface leaves the list", () => {
    const stale: string[] = [];
    for (const [rel, allowed] of HANDROLLED_ALLOW) {
      const lines = found.get(rel) ?? [];
      if (lines.length < allowed.count) {
        stale.push(
          `${rel}: allowlisted at ${allowed.count} but ${lines.length} remain ` +
            "— shrink (or remove) its entry so the ratchet holds"
        );
      }
    }
    expect(stale, stale.join("\n")).toEqual([]);
  });
});

describe("the time-input reader itself", () => {
  it("finds a multi-line tag whose attributes contain braces and arrows", () => {
    expect(
      rawTimeInputs(
        `<input\n  type="time"\n  value={t}\n  onChange={(e) => set(e.target.value > "" ? e.target.value : "")}\n/>`
      )
    ).toEqual([1]);
  });

  it("ignores other input types and non-input tags", () => {
    expect(rawTimeInputs(`<input type="text" /><IconClock type="time" />`)) //
      .toEqual([]);
  });

  it("ignores a tag mentioned in a comment or a string", () => {
    expect(
      rawTimeInputs(
        `// seeds its <input type="time"> with\nconst s = '<input type="time">';\n{/* <input type="time"> */}`
      )
    ).toEqual([]);
  });

  it("counts each of several inputs on their own lines", () => {
    expect(
      rawTimeInputs(
        `<input type="time" />\n<input type="date" />\n<input type="time" name="t" />`
      )
    ).toEqual([1, 3]);
  });
});
