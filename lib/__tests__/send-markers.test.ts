// The send-marker registry guard (issue #2036).
//
// The `notify_last_*` discipline was cited in eight places in the docs and enforced
// nowhere: fourteen-odd namespaces, each hand-building, parsing and sweeping its own
// keys, most of them inline literals that no scan could see. A marker keyed on something
// recyclable, or never swept after its subject is deleted, is a silent wrong-cadence bug
// — the same class #1931's DISMISSAL_KEY_REGISTRY made unshippable one file over.
//
// These tests are that registry's teeth:
//   1. TOTALITY — every `notify_…` key literal in lib/ and scripts/ resolves to a
//      declared marker or to an explicit not-a-marker entry with a stated reason.
//   2. EVIDENCE — every entry states its shape, value and retention; a claimed class
//      that needs a sweep has to name it.
//   3. AGREEMENT — the send-marker registry and the dismissal registry describe two
//      different stores and must not contradict each other.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DIGEST_MARKER_KEY,
  NON_MARKER_NOTIFY_KEYS,
  SEND_MARKER_KEYS,
  SEND_MARKER_REGISTRY,
  TICK_SLOT_MARKER_KEYS,
  WEEKLY_RECAP_MARKER_KEY,
  foodNudgeMarkerKey,
  intakeSlotMarkerKey,
  sendMarkerEntryFor,
} from "@/lib/notifications/send-markers";
import {
  DISMISSAL_KEY_PREFIXES,
  NON_DISMISSAL_PREFIXES,
} from "@/lib/dismissal-classes";

const ROOT = process.cwd();
// The registry is the DECLARATION, so scanning it would be circular — it is the one
// place the literals are supposed to be written out.
const DECLARATION_FILE = join(ROOT, "lib", "notifications", "send-markers.ts");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name.startsWith("__")) continue; // the three test tiers
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (
      (name.endsWith(".ts") || name.endsWith(".tsx")) &&
      !name.endsWith(".d.ts") &&
      full !== DECLARATION_FILE
    )
      out.push(full);
  }
  return out;
}

// Comments MENTION marker names constantly (that is how the convention spread), so the
// scan has to look at code only. A small quote-aware stripper: it tracks the three
// string forms so a `//` inside a URL or a `/*` inside a message is never mistaken for
// the start of a comment.
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

interface FoundKey {
  key: string;
  file: string;
}

// Every `notify_…` settings key spelled in code: a plain string literal, or the static
// PREFIX of a template literal whose tail is interpolated.
const PATTERNS = [
  /"(notify_[A-Za-z0-9_]*)"/g,
  /'(notify_[A-Za-z0-9_]*)'/g,
  /`(notify_[A-Za-z0-9_]*)(?:\$\{|`)/g,
];

function foundKeys(): FoundKey[] {
  const out: FoundKey[] = [];
  for (const dir of ["lib", "scripts"]) {
    for (const file of sourceFiles(join(ROOT, dir))) {
      const src = stripComments(readFileSync(file, "utf8"));
      for (const re of PATTERNS)
        for (const m of src.matchAll(re))
          out.push({ key: m[1], file: file.slice(ROOT.length + 1) });
    }
  }
  return out;
}

const EXCLUDED = new Set(NON_MARKER_NOTIFY_KEYS.map((e) => e.key));

function accountedFor(key: string): boolean {
  if (sendMarkerEntryFor(key)) return true;
  // A not-a-marker entry may itself be a prefix (`notify_mute_profile_`).
  return [...EXCLUDED].some((e) => key === e || key.startsWith(e));
}

describe("send-marker registry (#2036)", () => {
  it("declares each namespace exactly once", () => {
    const seen = new Map<string, number>();
    for (const e of SEND_MARKER_REGISTRY)
      seen.set(e.key, (seen.get(e.key) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
  });

  it("gives every entry a shape, a value and a retention answer", () => {
    // "Nobody looked" and "we decided nothing sweeps this, and here is why" have to stay
    // distinguishable — the house rule every registry in this codebase follows.
    const thin = SEND_MARKER_REGISTRY.filter(
      (e) => !e.shape.trim() || !e.value.trim() || !e.retention.trim()
    ).map((e) => e.key);
    expect(thin).toEqual([]);
  });

  it("names the writer of every marker", () => {
    const anonymous = SEND_MARKER_REGISTRY.filter((e) => !e.writer.trim()).map(
      (e) => e.key
    );
    expect(anonymous).toEqual([]);
  });

  it("requires a named sweep for every name-keyed-swept namespace", () => {
    const unswept = SEND_MARKER_REGISTRY.filter(
      (e) => e.markerClass === "name-keyed-swept" && !e.sweptBy?.trim()
    ).map((e) => e.key);
    expect(
      unswept,
      "`name-keyed-swept` claims something de-orphans the key — name the function"
    ).toEqual([]);
  });

  it("never attaches a sweep to a class that doesn't have one", () => {
    const odd = SEND_MARKER_REGISTRY.filter(
      (e) => e.sweptBy && e.markerClass !== "name-keyed-swept"
    ).map((e) => e.key);
    expect(odd).toEqual([]);
  });

  it("keeps a retired namespace retired", () => {
    for (const e of SEND_MARKER_REGISTRY.filter(
      (x) => x.markerClass === "legacy"
    ))
      expect(e.cadence, e.key).toBe("retired");
  });

  it("resolves a stored key to its own entry, not a neighbour's", () => {
    expect(sendMarkerEntryFor("notify_last_refill_42")?.key).toBe(
      "notify_last_refill_"
    );
    expect(sendMarkerEntryFor("notify_last_pool_refill_42")?.key).toBe(
      "notify_last_pool_refill_"
    );
    expect(sendMarkerEntryFor("notify_last_practice")?.key).toBe(
      "notify_last_practice"
    );
    expect(sendMarkerEntryFor("notify_last_preventive_colonoscopy")?.key).toBe(
      "notify_last_preventive_"
    );
    expect(sendMarkerEntryFor("notify_last_post_workout_7")?.key).toBe(
      "notify_last_post_workout_"
    );
    // A slot family swallows its own longest member rather than being shadowed.
    expect(sendMarkerEntryFor("notify_last_supp_PreWorkout")?.key).toBe(
      "notify_last_supp_"
    );
    // A fixed key matches EXACTLY: nothing may inherit `notify_last_workout`'s entry.
    expect(sendMarkerEntryFor("notify_last_workout_9")).toBeNull();
    expect(sendMarkerEntryFor("notify_nonsense")).toBeNull();
  });

  it("resolves every key its own builders mint", () => {
    for (const key of [
      foodNudgeMarkerKey("Morning"),
      foodNudgeMarkerKey("Evening"),
      intakeSlotMarkerKey("Bedtime"),
      intakeSlotMarkerKey("PreWorkout"),
      ...Object.values(TICK_SLOT_MARKER_KEYS),
      DIGEST_MARKER_KEY,
      WEEKLY_RECAP_MARKER_KEY,
    ])
      expect(sendMarkerEntryFor(key), key).not.toBeNull();
  });
});

describe("send-marker source scan (#2036)", () => {
  it("finds the key literals it is supposed to guard", () => {
    // A sanity floor: if the literal shapes ever change, the scan must fail loudly
    // rather than silently pass over an empty set.
    const keys = foundKeys().map((f) => f.key);
    expect(keys.length).toBeGreaterThan(20);
    for (const expected of [
      "notify_last_refill_",
      "notify_last_esc_",
      "notify_last_household_",
      "notify_last_redose_",
    ])
      expect(keys).toContain(expected);
  });

  it("ignores marker names that only appear in prose", () => {
    // The convention spread through comments; the scan must not police them.
    const src = [
      "// the notify_last_practice marker, see `notify_last_${slot}`",
      '/* notify_last_bogus */ const k = "notify_last_digest";',
    ].join("\n");
    const stripped = stripComments(src);
    expect(stripped).toContain("notify_last_digest");
    expect(stripped).not.toContain("notify_last_practice");
    expect(stripped).not.toContain("notify_last_bogus");
  });

  it("keeps a URL out of the comment stripper's way", () => {
    expect(stripComments('const u = "https://example.test/x"; // gone')).toBe(
      'const u = "https://example.test/x"; '
    );
  });

  it("every notify_ key written in lib/ or scripts/ is declared", () => {
    const unaccounted = [
      ...new Set(
        foundKeys()
          .filter((f) => !accountedFor(f.key))
          .map((f) => `"${f.key}" (${f.file})`)
      ),
    ].sort();
    expect(
      unaccounted,
      "a new notify_ settings key must declare itself: add it to SEND_MARKER_REGISTRY " +
        "(with its class, cadence, store and what sweeps it) or to NON_MARKER_NOTIFY_KEYS " +
        "with what it actually keys — lib/notifications/send-markers.ts. A key composed " +
        "from a variable tail must mint through a declared builder there, or the scan " +
        "cannot see it at all."
    ).toEqual([]);
  });

  it("keeps the not-a-marker list honest", () => {
    const declared = new Set(SEND_MARKER_KEYS);
    for (const e of NON_MARKER_NOTIFY_KEYS) {
      expect(e.what.trim().length, e.key).toBeGreaterThan(0);
      // A key cannot be both a send marker and not one.
      expect(declared.has(e.key), e.key).toBe(false);
    }
  });
});

describe("agreement with the dismissal registry (#1931 / #2036)", () => {
  it("declares every notify_ prefix the dismissal registry excused", () => {
    // NON_DISMISSAL_PREFIXES carries six send-marker prefixes, recorded there only
    // because they are NOT dismissals. Each must be a real declaration over here, so the
    // two registries cannot disagree about what a key is.
    const missing = NON_DISMISSAL_PREFIXES.filter(
      (e) => e.prefix.startsWith("notify_") && !sendMarkerEntryFor(e.prefix)
    ).map((e) => e.prefix);
    expect(missing).toEqual([]);
  });

  it("never classifies a send marker as a suppression namespace", () => {
    // Different stores, different questions: `upcoming_dismissals.signal_key` is a
    // promise to a person, a send marker is the app's own bookkeeping. An overlap would
    // mean one of the two registries is describing the wrong thing.
    const dismissals = new Set(DISMISSAL_KEY_PREFIXES);
    const overlap = SEND_MARKER_KEYS.filter((k) => dismissals.has(k));
    expect(overlap).toEqual([]);
  });
});
