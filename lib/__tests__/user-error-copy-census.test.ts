import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rawErrorCopySites } from "@/lib/user-error-copy-census";

// #3198's guard: a caught error's own text may not reach a returned or persisted
// user-facing string. The rule itself lives in lib/user-error-copy-census.ts so it
// can be run over sources authored to break it; this file runs it over the tree and
// holds the frozen allowlist.
//
// ITS SCOPE IS DECLARED, AND IT IS NARROWER THAN "EVERY err.message IN THE REPO":
//
//   IN   app/** except app/api/** — every Server Action and page that returns or
//        persists an error string. `app/api/**` is the #478 generic-error layer
//        ("internal error"), which is a different standard and already met.
//   IN   the sinks #3198 censused: lib/import-persist.ts, lib/medical-pipeline.ts
//        (`medical_documents.extraction_error`), lib/medical-extract/**, and
//        lib/integrations/backfill-error.ts
//        (`integration_backfill_jobs.error`).
//
//   OUT  the rest of lib/integrations/** — a real sixth family that #3198's
//        five-path census missed, kept out of scope rather than half-fixed because
//        several of those strings carry an authored prefix an operator reads
//        ("Strava activities request failed: ECONNRESET") and deciding what a
//        person should see instead is the work of its own change (#3592).
//        THE EXCLUSION IS ENUMERATED AND ASSERTED, not described: see
//        SYNC_EVENT_EXCLUSIONS below. A prose glob cannot be checked — the one
//        that stood here named the wrong files (it missed open-meteo.ts, which
//        matches neither `*-sync.ts` nor `pull-sync.ts`) and claimed a count that
//        reconciles with no reading of the tree.
//
// A wider scope would report on a question this change did not ask; a narrower one
// would report on nothing. Both failures are the same bug.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const SCAN_DIRS = [
  "app",
  "lib/medical-extract",
  "lib/import-persist.ts",
  // Every module that WRITES `medical_documents.extraction_error`, not only the
  // one the issue named. Scoping the guard to lib/medical-pipeline.ts alone left
  // lib/health-record-doc.ts — the deterministic CCD/SHC import path — writing a
  // raw `err.message` to the same rendered column, and the guard could not see it.
  // Keyed to the WRITERS so a new one is caught by the class rather than found by
  // hand: `git grep -n "SET .*extraction_error = ?"` names exactly these.
  "lib/medical-pipeline.ts",
  "lib/medical-pipeline",
  "lib/health-record-doc.ts",
  "lib/extraction-reaper.ts",
  "lib/document-upload-api.ts",
  "lib/integrations/backfill-error.ts",
];
const EXCLUDE_PREFIX = ["app/api/"];

// FROZEN, and it only ever shrinks. Keyed by (file, exact substring) so an entry
// survives ordinary edits above it.
//
// Two classes, and each is a DELIBERATE prior decision this change declined to
// overturn silently rather than a hit that was tidied away.
const SPECIALIZED_TRANSLATION =
  "The in-repo precedent #3198 generalizes: this MATCHES on the message to decide " +
  "which house sentence to return ('that username is taken') and never returns the " +
  "message itself. A specific answer beats a shaped one, so it stays as-is.";
const ADMIN_DIAGNOSTIC =
  "An ADMIN diagnostic whose entire job is to report what the far end said: a test " +
  "send, a backup run, a webhook registration. The upstream text IS the payload " +
  "here — a wrong Home Assistant URL, an unreachable Telegram, a snapshot that " +
  "failed integrity_check — and app/(app)/settings/profile/actions.ts records that " +
  "intent in its own words ('Reports the failure verbatim so a wrong URL / " +
  "unreachable HA is visible'). Classifying these would replace the one thing the " +
  "admin came for with a sentence that says nothing. Raised for the owner rather " +
  "than decided here; if the ruling goes the other way, each of these takes a " +
  "userErrorCopy call and this class disappears from the list.";
const ADMIN_RETURN =
  "return { ok: false, message: e instanceof Error ? e.message : String(e) };";
const CLIENT_PUSH = "message: e instanceof Error ? e.message : String(e),";
const ALLOW: { file: string; substring: string; why: string }[] = [
  {
    file: "app/(app)/settings/family/actions.ts",
    substring:
      "/UNIQUE constraint failed: logins\\.username/i.test(err.message)",
    why: SPECIALIZED_TRANSLATION,
  },
  {
    file: "app/(app)/settings/family/actions.ts",
    substring: "/UNIQUE constraint failed: logins\\.email/i.test(err.message)",
    why: SPECIALIZED_TRANSLATION,
  },
  {
    file: "app/(app)/settings/actions.ts",
    substring: ADMIN_RETURN,
    why: `${ADMIN_DIAGNOSTIC} Here: the push, Telegram and email test sends.`,
  },
  {
    file: "app/(app)/settings/profile/actions.ts",
    substring: ADMIN_RETURN,
    why: `${ADMIN_DIAGNOSTIC} Here: the Home Assistant and all-channel test sends.`,
  },
  {
    file: "app/(app)/settings/server/actions.ts",
    substring: ADMIN_RETURN,
    why: `${ADMIN_DIAGNOSTIC} Here: "Back up now" and the Telegram webhook registration.`,
  },
  {
    file: "app/(app)/settings/notifications/PushNotificationSettings.tsx",
    substring: CLIENT_PUSH,
    why:
      "The BROWSER's own PushManager DOMException, not an internal of ours — " +
      "'Registration failed - push service error' is the only signal there is for " +
      "a blocked or unsupported push service, and it is shown on the very control " +
      "that just failed. Nothing in this string comes from the app's schema or " +
      "stack. Raised with the class above.",
  },
];

// THE EXCLUSION, FROZEN AND ASSERTED (#3592).
//
// `integration_sync_events` is the sixth family, and it is out of scope above. It
// used to be excluded in PROSE, which nothing could check: a ninth site could
// appear, all nine could be fixed, or the family could grow a file, and this test
// stayed green either way. The paragraph was also wrong three ways — it named
// `lib/integrations/*-sync.ts` and `pull-sync.ts`, a glob that covers seven of the
// nine sites and misses `open-meteo.ts` entirely, and it claimed "eight", a number
// that matches neither the nine raw sites nor the seven that reach `.error`.
//
// So the set is ENUMERATED here in the same (file, substring) shape as ALLOW, and
// the assertion below is a MULTISET EQUALITY against what the rule actually finds
// in lib/integrations/**. The count is `SYNC_EVENT_EXCLUSIONS.length`, never a
// number in a sentence. A tenth site goes red (unlisted). Fixing one goes red
// (stale entry) — which is the direction that matters, because #3592 closing this
// family must delete its entries here rather than leave a paragraph describing a
// tree that moved on.
//
// `column` is the sink each site actually reaches, traced rather than assumed —
// two of the nine never touch `.error` at all.
const SYNC_EVENT_EXCLUSIONS: {
  file: string;
  substring: string;
  column: "error" | "details";
  why: string;
}[] = [
  {
    file: "lib/integrations/open-meteo.ts",
    substring: "error: err instanceof Error ? err.message : String(err),",
    column: "error",
    why:
      "openMeteoFetch (the HOURLY fetch). Its `error` is read at " +
      'weather-sync.ts\'s `res.error ?? "weather fetch failed …"` and passed ' +
      "straight to recordSyncEvent as `error`.",
  },
  {
    file: "lib/integrations/open-meteo.ts",
    substring: "error: err instanceof Error ? err.message : String(err),",
    column: "details",
    why:
      "getJson, used only by openMeteoFetchDaily. BOTH of its paths — the weather " +
      "half's `daily.error` and the air half's `daily.partial` — land in " +
      "weather-sync's `partial`, which is written to `details` through " +
      "weatherPartialWarning, never to `error`. The prose count treated this as " +
      "an `.error` site; it is not one.",
  },
  {
    file: "lib/integrations/oura-sync.ts",
    substring: "error: err instanceof Error ? err.message : String(err),",
    column: "error",
    why:
      "The Oura fetch's non-HTTP failure (status 0). Surfaces as the PullSpec " +
      "gather outcome's `error`, which pull-sync writes to `error`.",
  },
  {
    file: "lib/integrations/pull-sync.ts",
    substring:
      "const message = err instanceof Error ? err.message : String(err);",
    column: "error",
    why: "The authorize() throw. Written to `error` on the same line.",
  },
  {
    file: "lib/integrations/pull-sync.ts",
    substring:
      "const message = err instanceof Error ? err.message : String(err);",
    column: "error",
    why: "The write-transaction throw. Written to `error` in the same block.",
  },
  {
    file: "lib/integrations/strava-sync.ts",
    substring: "error: err instanceof Error ? err.message : String(err),",
    column: "error",
    why:
      "The Strava fetch's non-HTTP failure (status 0). Same gather-outcome route " +
      "to `error` as Oura and Withings.",
  },
  {
    file: "lib/integrations/weather-sync.ts",
    substring:
      "const message = err instanceof Error ? err.message : String(err);",
    column: "error",
    why: "The upsertUvHours write failure. Written to `error` in the same block.",
  },
  {
    file: "lib/integrations/weather-sync.ts",
    substring: "partial = err instanceof Error ? err.message : String(err);",
    column: "details",
    why:
      "The upsertWeatherDays write failure. It sets `partial`, which reaches " +
      "`details` (and the returned summary), never `error` — the run is still " +
      "recorded `ok: true` and degraded (#2567).",
  },
  {
    file: "lib/integrations/withings-sync.ts",
    substring: "error: err instanceof Error ? err.message : String(err),",
    column: "error",
    why:
      "The Withings fetch's non-HTTP failure (status 0). Same gather-outcome " +
      "route to `error`.",
  },
];

function walk(target: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(target)) return out;
  if (fs.statSync(target).isFile()) return [target];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function scanned(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    for (const full of walk(path.join(REPO, d))) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__tests__")) continue;
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      if (EXCLUDE_PREFIX.some((p) => rel.startsWith(p))) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

function allowed(rel: string, text: string): boolean {
  return ALLOW.some((a) => a.file === rel && text.includes(a.substring));
}

describe("the rule can SEE every shape the defect takes", () => {
  // Each offender carries its `catch` clause, because that is how the defect is
  // actually written and the rule keys on the binding.
  const caught = (body: string) =>
    `try {\n  work();\n} catch (err) {\n${body}\n}`;
  const offenders: [string, string][] = [
    [
      "persisted onto a row",
      caught(
        '  db.prepare("UPDATE jobs SET error = ?").run(`Crashed: ${err.message}`, id);'
      ),
    ],
    [
      "returned from a Server Action",
      caught(
        `  return { error: err instanceof Error ? err.message : "Couldn't save." };`
      ),
    ],
    [
      "returned through String(err)",
      caught("  return { error: String(err) };"),
    ],
    [
      "interpolated with no property access at all",
      caught("  return { error: `Import failed: ${err}` };"),
    ],
    [
      "a stack fragment, which is worse than a message",
      caught('  return { error: err.stack ?? "" };'),
    ],
    [
      "spanning several lines, where a line-anchored test sees nothing",
      caught(
        `  return {\n    error:\n      err instanceof Error\n        ? err.message\n        : "unknown",\n  };`
      ),
    ],
    [
      "on a line that MENTIONS a logger without being one",
      caught("  const detail = err.message; // not logged, just rendered"),
    ],
    [
      "bound as `e`, the other name everyone reaches for",
      caught("  return { ok: false, message: e.message };").replace(
        "catch (err)",
        "catch (e)"
      ),
    ],
  ];
  for (const [name, source] of offenders) {
    it(`flags: ${name}`, () => {
      expect(rawErrorCopySites(source).length).toBeGreaterThan(0);
    });
  }
});

describe("the rule stays QUIET on the homes a caught error legitimately has", () => {
  const caught = (body: string) =>
    `try {\n  work();\n} catch (err) {\n${body}\n}`;
  const benign: [string, string][] = [
    [
      "a single-line log call",
      caught('  log.error("boom", { err: String(err) });'),
    ],
    [
      "a log call split across lines, parenthesized arguments and all",
      caught(
        `  log.error("provider identity update failed", {\n    id,\n    err: err instanceof Error ? err : String(err),\n  });`
      ),
    ],
    [
      "a log call whose message contains a close paren",
      caught('  log.warn("failed (retrying)", { err: err.message });'),
    ],
    ["a console call", caught('  console.error("boom", err.message);')],
    [
      "a thrown Error naming the failing table (#1808)",
      caught(
        "  throw new Error(\n    `Clearing imported ${t.table} rows failed: ${\n      err instanceof Error ? err.message : String(err)\n    }`,\n    { cause: err }\n  );"
      ),
    ],
    [
      "an AI-log event",
      caught('  recordAiEvent({ status: "failed", error: String(err) });'),
    ],
    [
      "prose in a comment quoting the defect it warns against",
      caught(
        '  // never return err.message to a person\n  return { error: "Couldn\'t save this." };'
      ),
    ],
    [
      "a block comment doing the same",
      caught(
        '  /* err.message and String(err) both belong in the log */\n  return { error: "Couldn\'t save this." };'
      ),
    ],
    [
      "the classifier's own vocabulary, used correctly",
      caught(
        '  return { error: userErrorCopy(err, { doing: "save this provider" }) };'
      ),
    ],
    [
      "a `.map()` row that happens to be called `e` and carries a `message` field",
      "rows.map((e) => <span key={e.id}>{e.message}</span>);",
    ],
  ];
  for (const [name, source] of benign) {
    it(`is silent on: ${name}`, () => {
      expect(rawErrorCopySites(source)).toEqual([]);
    });
  }
});

describe("no caught error's text reaches a user-facing string in the declared scope", () => {
  it("has a scope that is not empty (a floor, so an emptied glob cannot pass)", () => {
    // Measured 2026-08-23. A "no violations" assertion over zero files is the
    // failure mode this floor exists to catch.
    expect(scanned().length).toBeGreaterThan(400);
  });

  it("finds no unallowed site", () => {
    const violations: string[] = [];
    for (const { rel, text } of scanned()) {
      for (const site of rawErrorCopySites(text)) {
        if (allowed(rel, site.text)) continue;
        violations.push(`${rel}:${site.line} — ${site.text}`);
      }
    }
    expect(
      violations,
      `A caught error's own text may not reach a returned or persisted ` +
        `user-facing string (#3198). Route it through lib/user-error-copy.ts ` +
        `and send the raw cause to log.error. A legitimate exception goes on ` +
        `this test's frozen ALLOW list with a justification:\n` +
        violations.join("\n")
    ).toEqual([]);
  });

  it("the integration_sync_events exclusion is the set it says it is", () => {
    // Multiset equality: every site the rule finds in lib/integrations/** must be
    // listed, and every listed entry must still match a site. `lib/integrations/
    // backfill-error.ts` is IN scope above and carries no raw site, so it needs no
    // carve-out here — if it ever regressed, it would surface as an unlisted site.
    const key = (file: string, substring: string) => `${file} :: ${substring}`;
    const found: string[] = [];
    for (const full of walk(path.join(REPO, "lib/integrations"))) {
      const rel = path.relative(REPO, full).split(path.sep).join("/");
      if (rel.includes("__tests__")) continue;
      if (rel.endsWith(".test.ts") || rel.endsWith(".test.tsx")) continue;
      for (const site of rawErrorCopySites(fs.readFileSync(full, "utf8"))) {
        found.push(key(rel, site.text));
      }
    }
    const listed = SYNC_EVENT_EXCLUSIONS.map((e) => key(e.file, e.substring));
    expect(
      found.slice().sort(),
      `The integration_sync_events exclusion is FROZEN and enumerated ` +
        `(#3592). A site here that is not on SYNC_EVENT_EXCLUSIONS is a NEW ` +
        `member of a family this change deliberately left alone — add it with ` +
        `the column it reaches, or fix it. An entry that no longer matches ` +
        `means the site was fixed or moved: delete the entry (or re-key it) ` +
        `rather than leaving the list describing a tree that moved on. Listed ` +
        `${listed.length}, found ${found.length}.`
    ).toEqual(listed.slice().sort());
  });

  it("still sees the one file it is most likely to be broken by", () => {
    // A NAMED SUBJECT: the settings/family translations are the only allowed
    // sites, so an allowlist that stopped matching — or a rule that stopped
    // firing — shows up here rather than as a silent green.
    const family = fs.readFileSync(
      path.join(REPO, "app/(app)/settings/family/actions.ts"),
      "utf8"
    );
    const sites = rawErrorCopySites(family);
    expect(sites.length).toBeGreaterThan(0);
    expect(
      sites.every((s) =>
        allowed("app/(app)/settings/family/actions.ts", s.text)
      )
    ).toBe(true);
  });
});
