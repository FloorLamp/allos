import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IDENTITY_OUTCOMES,
  buildSyncRequestList,
  isIdentityOutcome,
  parseDiscoveredLabels,
  parseReportedIdentities,
  parseSyncReportProvenance,
  reportAdvancesStalenessClock,
  reportAnswersRequest,
  reportCountsAsCheck,
  reportIsUnattendedFailure,
} from "@/lib/acquirer-identity";

// PURE TIER — what KIND of run a sync report describes (#1888, #1889). No DB, no network.
//
// #1888's first implementation constraint is the reason this file exists: "answers a
// request" and "advances the staleness clock" must not be two hand-written predicates that
// happen to agree today, because that is exactly the drift that produced the bug. So the
// two consumers are pinned AGAINST THE ONE FUNCTION here, and the last describe block
// reads lib/portal-requests.ts's own source to prove the two SQL consumers embed one
// shared fragment rather than each spelling out a variant.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

describe("reportCountsAsCheck — the one predicate", () => {
  it("absent means contacted: every existing client keeps its meaning", () => {
    expect(reportCountsAsCheck({})).toBe(true);
    expect(reportCountsAsCheck({ attended: false })).toBe(true);
  });

  it("only an explicit false means a delivery-only report", () => {
    expect(reportCountsAsCheck({ contacted: false })).toBe(false);
    expect(reportCountsAsCheck({ contacted: true })).toBe(true);
  });
});

describe("the two consumers derive from the one predicate", () => {
  // Every combination of the three inputs the predicates can see. Pinning the consumers
  // as FUNCTIONS OF reportCountsAsCheck — rather than restating their truth tables — is
  // what stops a third consumer inventing a variant.
  const combos = [true, false, undefined].flatMap((contacted) =>
    [true, false, undefined].flatMap((attended) =>
      [true, false].map((ok) => ({ contacted, attended, ok }))
    )
  );

  it("a report that is not a check answers nothing and advances nothing", () => {
    for (const c of combos) {
      if (reportCountsAsCheck(c)) continue;
      expect(reportAnswersRequest(c), JSON.stringify(c)).toBe(false);
      expect(reportAdvancesStalenessClock(c), JSON.stringify(c)).toBe(false);
      expect(reportIsUnattendedFailure(c), JSON.stringify(c)).toBe(false);
    }
  });

  it("the staleness clock is exactly the one predicate AND a successful run", () => {
    for (const c of combos) {
      expect(reportAdvancesStalenessClock(c), JSON.stringify(c)).toBe(
        reportCountsAsCheck(c) && c.ok
      );
    }
  });

  it("the staleness clock is a subset of the answering signal", () => {
    for (const c of combos) {
      if (!reportAdvancesStalenessClock(c)) continue;
      expect(reportAnswersRequest(c), JSON.stringify(c)).toBe(true);
    }
  });
});

describe("attended — a failed run answers a request only if someone was there", () => {
  it("a failed ATTENDED run answers: the person went to the machine", () => {
    expect(reportAnswersRequest({ ok: false })).toBe(true);
    expect(reportAnswersRequest({ ok: false, attended: true })).toBe(true);
  });

  it("a failed UNATTENDED run leaves the request open", () => {
    // The ask must not disappear at the exact point it became true.
    expect(reportAnswersRequest({ ok: false, attended: false })).toBe(false);
  });

  it("a SUCCESSFUL unattended run still answers: records arrived", () => {
    expect(reportAnswersRequest({ ok: true, attended: false })).toBe(true);
  });

  it("only a failed unattended CONTACT is an escalation", () => {
    expect(reportIsUnattendedFailure({ ok: false, attended: false })).toBe(
      true
    );
    expect(reportIsUnattendedFailure({ ok: true, attended: false })).toBe(
      false
    );
    expect(reportIsUnattendedFailure({ ok: false, attended: true })).toBe(
      false
    );
    // A delivery-only push never tried to sign in, so there is nothing to escalate.
    expect(
      reportIsUnattendedFailure({
        ok: false,
        attended: false,
        contacted: false,
      })
    ).toBe(false);
  });
});

describe("parseSyncReportProvenance — absent means true", () => {
  it("an older client's body reads as a contacted, attended run", () => {
    expect(parseSyncReportProvenance({})).toEqual({
      contacted: true,
      attended: true,
    });
  });

  it("reads the booleans a client actually sends", () => {
    expect(
      parseSyncReportProvenance({ contacted: false, attended: false })
    ).toEqual({ contacted: false, attended: false });
  });

  it("accepts the string spellings, because misreading them restores the bug", () => {
    expect(parseSyncReportProvenance({ contacted: "false" }).contacted).toBe(
      false
    );
    expect(parseSyncReportProvenance({ attended: "0" }).attended).toBe(false);
  });

  it("junk degrades to the wire default rather than refusing the report", () => {
    expect(parseSyncReportProvenance({ contacted: 7 }).contacted).toBe(true);
    expect(parseSyncReportProvenance({ attended: null }).attended).toBe(true);
  });
});

describe("per-identity outcomes — one run, several answers", () => {
  it("bare strings keep their original meaning, with no outcome stated", () => {
    expect(parseReportedIdentities(["JANE DOE", "ALEX DOE"])).toEqual([
      { label: "JANE DOE", outcome: null },
      { label: "ALEX DOE", outcome: null },
    ]);
  });

  it("an object entry carries what the run managed for that patient", () => {
    expect(
      parseReportedIdentities([
        { patient: "JANE DOE", outcome: "collected" },
        { patient: "ALEX DOE", outcome: "declined" },
      ])
    ).toEqual([
      { label: "JANE DOE", outcome: "collected" },
      { label: "ALEX DOE", outcome: "declined" },
    ]);
  });

  it("an unrecognised outcome degrades to unstated, never rejecting the report", () => {
    expect(
      parseReportedIdentities([{ patient: "JANE DOE", outcome: "exploded" }])
    ).toEqual([{ label: "JANE DOE", outcome: null }]);
  });

  it("the two spellings mix, and the label rules are unchanged", () => {
    expect(
      parseReportedIdentities([
        "  JANE   DOE ",
        { patient: "JANE DOE", outcome: "declined" },
        { patient: "   ", outcome: "declined" },
        { outcome: "declined" },
        42,
      ])
    ).toEqual([{ label: "JANE DOE", outcome: null }]);
  });

  it("the label-only reading is derived from the same parser", () => {
    const raw = ["JANE DOE", { patient: "ALEX DOE", outcome: "declined" }];
    expect(parseDiscoveredLabels(raw)).toEqual(["JANE DOE", "ALEX DOE"]);
    expect(parseDiscoveredLabels(raw)).toEqual(
      parseReportedIdentities(raw).map((e) => e.label)
    );
  });

  it("the outcome vocabulary is a closed set", () => {
    expect([...IDENTITY_OUTCOMES]).toEqual(["collected", "declined"]);
    expect(isIdentityOutcome("declined")).toBe(true);
    expect(isIdentityOutcome("failed")).toBe(false);
  });
});

describe("buildSyncRequestList — the disclosure boundary", () => {
  const built = buildSyncRequestList([
    {
      portalSlug: "ochsner",
      accountSlug: "mom",
      reason: "post-visit",
      expiresAt: "2026-08-08 09:00:00",
    },
  ]);

  it("carries slugs, reason and the expiry DAY — and nothing else", () => {
    expect(built).toEqual([
      {
        portal: "ochsner",
        account: "mom",
        reason: "post-visit",
        expires: "2026-08-08",
      },
    ]);
    expect(Object.keys(built[0]).sort()).toEqual([
      "account",
      "expires",
      "portal",
      "reason",
    ]);
  });

  it("cannot carry an account NICKNAME or anything address-shaped", () => {
    const serialized = JSON.stringify(built);
    for (const forbidden of ["http", "://", "Mom", "name", "url", "host"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

// ── The SQL half of the same one-computation guarantee ───────────────────────
//
// Both consumers live in lib/portal-requests.ts, and both read through SQL, so the pure
// function alone cannot prove they agree. This reads that module's own source and pins
// the structural property the owner asked for: ONE shared fragment, embedded by both
// statements, and no second hand-written spelling of the predicate anywhere in the file.
// The house already tests source this way (profile-scoping, icon-button tooltips).
describe("the two SQL consumers embed one shared clock fragment", () => {
  const src = fs.readFileSync(
    path.join(REPO, "lib/portal-requests.ts"),
    "utf8"
  );

  it("defines the fragment once", () => {
    expect(src.match(/const CHECK_CLOCK_COLS = /g)).toHaveLength(1);
  });

  it("the answering projection and the staleness query both embed it", () => {
    // REQUEST_COLS feeds openSyncRequests (lastReportAt); STALENESS_CANDIDATES_STMT feeds
    // isStalenessDue (lastOkAt). Both must interpolate the constant, not restate it.
    const requestCols = src.slice(
      src.indexOf("const REQUEST_COLS ="),
      src.indexOf("const REQUEST_FROM =")
    );
    const staleness = src.slice(
      src.indexOf("const STALENESS_CANDIDATES_STMT ="),
      src.indexOf("// The profile-local")
    );
    expect(requestCols).toContain("${CHECK_CLOCK_COLS}");
    expect(staleness).toContain("${CHECK_CLOCK_COLS}");
  });

  it("the ever-ran fact is one fragment on the same joins (#2064)", () => {
    // "Has the tool ever run" is a different question from "when was it last
    // checked" (see the constants' own headers), but it is answered by the SAME
    // LEFT JOIN both enumerations already make. One fragment, embedded twice, and
    // no per-account existence statement growing back beside it.
    expect(src.match(/const EVER_RAN_COL = /g)).toHaveLength(1);
    expect(src.match(/\$\{EVER_RAN_COL\}/g)).toHaveLength(2);
    expect(src).not.toMatch(/FROM portal_run_reports\s+WHERE account_id/);
  });

  it("no consumer restates the predicate in SQL", () => {
    // `contacted` and `attended` are decided ONCE, at ingest, by the pure predicates.
    // A `WHERE rr.contacted = 1` appearing here would be the bug growing back.
    expect(src).not.toMatch(/\bcontacted\s*=\s*1\b/);
    expect(src).not.toMatch(/\battended\s*=\s*1\b/);
    // And the clock columns themselves are named in exactly one place.
    expect(src.match(/checked_at/g)).toHaveLength(1);
    expect(src.match(/checked_ok_at/g)).toHaveLength(1);
  });
});
