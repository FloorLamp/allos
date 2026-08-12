// SOURCE-SCAN tier — the notify tick's retention sweep census (#1843).
//
// The tick is the only thing in the product that runs on a schedule regardless of
// whether anyone opens the app, so it is the only place a table with no other
// pruner can be bounded. That made the sweep block a census, and #1843 was a HOLE
// in it: `purgeExpiredSessions` and `purgeExpiredTotpChallenges` both existed, but
// the login action was their only caller — so on a family instance where nobody
// signed in for months, expired `sessions` and `login_totp_challenges` rows
// accumulated with nothing anywhere to remove them. The functions being present
// looked exactly like the functions being run.
//
// This is a source scan rather than an execution test because scripts/notify.ts is
// a tsx entrypoint, not an importable module: what can be checked below the browser
// is that the tick names each sweep. The sweeps' own behaviour (what they delete,
// what they spare, the counts they report) is proven in lib/__db_tests__/auth.test.ts.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TICK = fs.readFileSync(
  path.join(process.cwd(), "scripts", "notify.ts"),
  "utf8"
);

// Every retention sweep the tick is responsible for driving, with the table it
// bounds. Growing this list is how a new unbounded table gets a pruner; a sweep
// that is imported but never called fails here, which is one line away from the
// #1843 shape (a purge that exists and nothing runs).
const TICK_SWEEPS: { fn: string; bounds: string }[] = [
  { fn: "pruneAuditEvents", bounds: "audit_events" },
  { fn: "sweepDeletedRows", bounds: "deleted_rows (undo/trash)" },
  { fn: "sweepReplayedKeys", bounds: "replayed_keys" },
  { fn: "pruneSyncEvents", bounds: "integration_sync_events" },
  { fn: "purgeExpiredSessions", bounds: "sessions" },
  { fn: "purgeExpiredTotpChallenges", bounds: "login_totp_challenges" },
];

describe("the notify tick's retention sweeps (#1843)", () => {
  it.each(TICK_SWEEPS)("imports and CALLS $fn to bound $bounds", ({ fn }) => {
    expect(TICK).toMatch(new RegExp(`\\b${fn}\\b`));
    // The call, not just the import — an unused import is the exact defect.
    expect(TICK).toMatch(new RegExp(`\\b${fn}\\(`));
  });

  it("keeps the session sweeps best-effort, like every sweep beside them", () => {
    // A retention sweep must never take the notification flow or the exit code
    // down with it: an expired-row cleanup failing is not a reason to skip
    // somebody's dose reminder. So the block catches, logs, and — unlike the
    // backup tick above it — does NOT touch `anyFailed`.
    const start = TICK.indexOf("  try {\n    const sweptSessions");
    expect(start).toBeGreaterThan(-1);
    const block = TICK.slice(start, TICK.indexOf("\n\n", start));
    expect(block).toMatch(/catch \(e\)/);
    expect(block).toMatch(/session sweep failed/);
    expect(block).not.toMatch(/anyFailed/);
  });
});
