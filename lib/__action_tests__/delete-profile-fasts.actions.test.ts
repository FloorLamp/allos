// SERVER-ACTION TIER — deleteProfile clears the fasting log (#2756).
//
// `fasts` is a profile-OWNED table, and its `profile_id` FK declares ON DELETE CASCADE
// — which is precisely NOT what clears it. deleteProfile sweeps with
// `PRAGMA foreign_keys = OFF` (#729), so the cascade never fires on the ONE path that
// deletes a profile; `deleteProfileData` deletes explicitly, one statement per
// OWNED_TABLES entry (lib/profile-delete.ts). Before the table joined that list a
// deleted profile's fasting rows survived the delete as orphans — the parent row gone,
// the child rows (real PHI) still there — which `PRAGMA foreign_key_check` reports by
// rowid and no user ever would.
//
// So this test drives the REAL action rather than the sweep in isolation, and asserts
// both halves: the rows are gone, and the schema is left with no dangling `fasts`
// reference into `profiles`. It fails against the un-registered table.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { deleteProfile } from "@/app/(app)/settings/family/actions";
import { OWNED_TABLES } from "@/lib/owned-tables";
import { endFast, startFast } from "@/lib/fast-write";
import { createLogin, createProfile, actAs, fd } from "./harness";

function fastCount(profileId: number): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM fasts WHERE profile_id = ?`)
      .get(profileId) as { n: number }
  ).n;
}

// Every FK violation the whole schema currently holds, as PRAGMA reports it.
function fkViolations(): { table: string; parent: string }[] {
  return db.prepare(`PRAGMA foreign_key_check`).all() as {
    table: string;
    parent: string;
  }[];
}

const HOUR = 3_600_000;

describe("deleteProfile clears fasts (#2756)", () => {
  it("removes the deleted profile's fasts — completed AND active — and leaves a bystander's", async () => {
    const admin = createLogin({ role: "admin" });
    const acting = createProfile("Acting Admin");
    const victim = createProfile("Test Patient");
    const bystander = createProfile("Ada Lovelace");
    actAs(admin, acting);

    const now = Date.now();
    // One COMPLETED fast (yesterday) and one still ACTIVE — the active row is the one
    // the partial unique index constrains, so both states must be swept.
    const first = startFast(victim.id, new Date(now - 30 * HOUR));
    expect(first.kind).toBe("started");
    expect(endFast(victim.id, new Date(now - 14 * HOUR)).kind).toBe("ended");
    expect(startFast(victim.id, new Date(now - 5 * HOUR)).kind).toBe("started");

    expect(startFast(bystander.id, new Date(now - 3 * HOUR)).kind).toBe("started");

    expect(fastCount(victim.id)).toBe(2);
    expect(fkViolations().filter((v) => v.table === "fasts")).toEqual([]);

    const res = await deleteProfile(fd({ id: victim.id }));
    expect(res.ok).toBe(true);

    expect(fastCount(victim.id)).toBe(0);
    expect(fastCount(bystander.id)).toBe(1); // bystander untouched

    // The orphan check the row count alone cannot make: nothing in `fasts` may point at
    // a profile that no longer exists. This is what came back with two rowids before the
    // table was registered.
    expect(fkViolations().filter((v) => v.table === "fasts")).toEqual([]);
  });

  it("fasts is an OWNED table (the sweep + the scoping scan + export completeness)", () => {
    expect((OWNED_TABLES as readonly string[]).includes("fasts")).toBe(true);
  });
});
