// SERVER-ACTION TIER — demo-mode write refusal (#181).
//
// In a public demo (ALLOS_DEMO_MODE set) a non-admin write must be refused at the
// requireWriteAccess() boundary regardless of the grant. The auth mock (setup.ts)
// applies the SAME pure predicate (isDemoRestricted) the real guard does, so this
// drives a real write action through it: a demo member's write throws and lands NO
// row, while the admin (and the same member with the flag off) still writes.

import { describe, it, expect, afterEach } from "vitest";
import { db } from "@/lib/db";
import { addBodyMetric } from "@/app/(app)/trends/body-actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

function rowsFor(profileId: number) {
  return db
    .prepare("SELECT id FROM body_metrics WHERE profile_id = ?")
    .all(profileId) as { id: number }[];
}

afterEach(() => {
  // process.env is shared across the worker — always clear so a later file isn't
  // silently left in demo mode.
  delete process.env.ALLOS_DEMO_MODE;
});

describe("demo mode write guard", () => {
  it("refuses a non-admin (member) write and writes no row", async () => {
    process.env.ALLOS_DEMO_MODE = "1";
    const login = createLogin({ role: "member" });
    const profile = createProfile("demo-member", login.id); // read grant not even needed
    actAs(login, profile, "write"); // even a (misconfigured) write grant is blocked

    await expect(
      addBodyMetric(fd({ date: "2026-02-01", weight: 80 }))
    ).rejects.toThrow(/demo mode/i);

    expect(rowsFor(profile.id)).toHaveLength(0);
  });

  it("still lets an admin write in demo mode (operator stays functional)", async () => {
    process.env.ALLOS_DEMO_MODE = "1";
    const login = createLogin({ role: "admin", weightUnit: "kg" });
    const profile = createProfile("demo-admin");
    actAs(login, profile, "write");

    await addBodyMetric(fd({ date: "2026-02-02", weight: 81 }));

    expect(rowsFor(profile.id)).toHaveLength(1);
  });

  it("lets the same member write when the flag is OFF (no behavior change by default)", async () => {
    // No ALLOS_DEMO_MODE set.
    const login = createLogin({ role: "member", weightUnit: "kg" });
    const profile = createProfile("normal-member", login.id);
    actAs(login, profile, "write");

    await addBodyMetric(fd({ date: "2026-02-03", weight: 82 }));

    expect(rowsFor(profile.id)).toHaveLength(1);
  });
});
