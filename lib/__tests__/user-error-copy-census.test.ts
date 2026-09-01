import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript-api";
import { CdaError } from "@/lib/cda/constants";
import { FhirError } from "@/lib/fhir/common";
import { SmartHealthCardError } from "@/lib/smart-health-card";
import { UserFacingError, userErrorCopy } from "@/lib/user-error-copy";
import { rawErrorCopySites } from "@/lib/user-error-copy-census";
import { ZipIndexError } from "@/lib/zip-index";

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
//   IN   lib/integrations/** — the SIXTH family, `integration_sync_events.error`
//        and `.details`, which #3198's five-path census missed and #3588 froze as
//        an enumerated nine-site exclusion. #3592 closed it: all nine sites now
//        log the raw cause and put house copy on the column, so the directory is
//        in scope like any other sink and the exclusion list is gone. The list
//        was the right shape for a set that still existed; an EMPTY frozen list
//        is not a guard, and scanning the directory is the guard it stood in for.
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
  // The whole sixth-family directory, not only backfill-error.ts. Every writer of
  // `integration_sync_events.error` / `.details` lives here (#3592), and keying the
  // scope to the DIRECTORY rather than to the seven files that happened to hold a
  // site is what stops the family re-opening in an eighth one — `open-meteo.ts`
  // matched neither `*-sync.ts` nor `pull-sync.ts`, which is exactly how the prose
  // glob that used to describe this set missed two of its nine members.
  "lib/integrations",
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

const PARSER_ERRORS = new Set([
  "CdaError",
  "FhirError",
  "SmartHealthCardError",
  "ZipIndexError",
]);

function parserErrorMessages(): { site: string; literal: boolean }[] {
  const messages: { site: string; literal: boolean }[] = [];
  for (const full of walk(path.join(REPO, "lib"))) {
    const rel = path.relative(REPO, full).split(path.sep).join("/");
    if (rel.includes("__tests__") || rel.includes(".test.")) continue;
    const source = ts.createSourceFile(
      rel,
      fs.readFileSync(full, "utf8"),
      ts.ScriptTarget.Latest,
      true
    );
    function visit(node: ts.Node): void {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        PARSER_ERRORS.has(node.expression.text)
      ) {
        const message = node.arguments?.[0];
        const line =
          source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
        messages.push({
          site: `${rel}:${line}`,
          literal:
            message !== undefined &&
            (ts.isStringLiteral(message) ||
              ts.isNoSubstitutionTemplateLiteral(message)),
        });
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return messages;
}

describe("parser errors are reader-authored copy", () => {
  it("uses the shared typed boundary for every parser family", () => {
    for (const ErrorType of [
      CdaError,
      FhirError,
      SmartHealthCardError,
      ZipIndexError,
    ]) {
      const error = new ErrorType("This import needs a different file.");
      expect(error).toBeInstanceOf(UserFacingError);
      expect(userErrorCopy(error, { doing: "import this file" })).toBe(
        "This import needs a different file."
      );
    }
  });

  it("keeps every parser error message literal and interpolation-free", () => {
    const messages = parserErrorMessages();
    expect(messages).toHaveLength(28);
    expect(
      messages.filter(({ literal }) => !literal).map(({ site }) => site)
    ).toEqual([]);
  });
});

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

  it("scans the sixth family's directory, by name", () => {
    // A NAMED SUBJECT for the scope change (#3592). `integration_sync_events` was
    // excluded as a frozen nine-entry list; the entries are gone because the sites
    // are fixed, and what replaces them is this directory being IN the scan. That
    // is only true while these files are actually reached — a SCAN_DIRS edit, a
    // rename, or a walk that stops descending would otherwise turn the guard off
    // silently and leave the sweep above reporting a clean tree it never read.
    const rels = new Set(scanned().map((f) => f.rel));
    for (const file of [
      "lib/integrations/connections.ts",
      "lib/integrations/open-meteo.ts",
      "lib/integrations/oura-sync.ts",
      "lib/integrations/pull-sync.ts",
      "lib/integrations/strava-sync.ts",
      "lib/integrations/weather-sync.ts",
      "lib/integrations/withings-sync.ts",
    ]) {
      expect(rels.has(file), `${file} is not in the scanned set`).toBe(true);
    }
  });

  it("would still SEE a raw site in that directory (the rule, on a forgery)", () => {
    // The sweep above is green because the family is fixed, and a green sweep over
    // a complying tree says nothing about what it can see. So the rule is run over
    // a source authored in the exact shape the nine fixed sites had — the Oura /
    // Withings / Strava fetch catch — and must flag it.
    const forged = [
      "async function providerGet(path: string) {",
      "  try {",
      "    return { ok: true, json: await fetch(path) };",
      "  } catch (err) {",
      "    return {",
      "      ok: false,",
      "      status: 0,",
      "      error: err instanceof Error ? err.message : String(err),",
      "    };",
      "  }",
      "}",
    ].join("\n");
    expect(rawErrorCopySites(forged)).toHaveLength(1);
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
