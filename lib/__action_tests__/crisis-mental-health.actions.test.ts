// SERVER-ACTION TIER (#997/#996) — the write paths added for the mental-health
// appointment kind, the shared-detail override, and the crisis-resources config
// (global + per-profile). Drives the real actions against the in-memory DB with the
// mocked auth boundary (setup.ts).

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { createAppointment } from "@/app/(app)/encounters/appointment-actions";
import {
  saveMentalHealthShareFull,
  saveProfileCrisisResources,
} from "@/app/(app)/settings/profile/actions";
import { saveCrisisResources } from "@/app/(app)/settings/server/actions";
import {
  getMentalHealthShareFull,
  getProfileCrisisResourcesOverride,
  getGlobalCrisisResources,
} from "@/lib/settings";
import { actAs, createLogin, createProfile, fd } from "./harness";

describe("createAppointment — mental_health kind (#997)", () => {
  it("persists the mental_health kind through the validated write boundary", async () => {
    const login = createLogin();
    const profile = createProfile("appt-mh", login.id);
    actAs(login, profile);

    const r = await createAppointment(
      fd({
        scheduled_at: "2026-08-01",
        title: "Session",
        kind: "mental_health",
      })
    );
    expect(r.ok).toBe(true);

    const row = db
      .prepare(
        "SELECT kind FROM appointments WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profile.id) as { kind: string | null };
    expect(row.kind).toBe("mental_health");
  });

  it("rejects a bogus kind to null (write-boundary guard)", async () => {
    const login = createLogin();
    const profile = createProfile("appt-badkind", login.id);
    actAs(login, profile);
    await createAppointment(
      fd({ scheduled_at: "2026-08-01", title: "x", kind: "not_a_kind" })
    );
    const row = db
      .prepare(
        "SELECT kind FROM appointments WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
      )
      .get(profile.id) as { kind: string | null };
    expect(row.kind).toBeNull();
  });
});

describe("saveMentalHealthShareFull (#997)", () => {
  it("toggles the per-profile shared-detail override", async () => {
    const login = createLogin();
    const profile = createProfile("share-toggle", login.id);
    actAs(login, profile);

    expect(getMentalHealthShareFull(profile.id)).toBe(false);
    await saveMentalHealthShareFull(fd({ mental_health_share_full: "1" }));
    expect(getMentalHealthShareFull(profile.id)).toBe(true);
    await saveMentalHealthShareFull(fd({ mental_health_share_full: "0" }));
    expect(getMentalHealthShareFull(profile.id)).toBe(false);
  });
});

describe("crisis-resources config (#996)", () => {
  it("saveCrisisResources sets the GLOBAL default from 'Label | contact' text", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("crisis-global", login.id);
    actAs(login, profile);

    await saveCrisisResources(
      fd({ crisis_resources: "Local line | 555-0100\n112" })
    );
    expect(getGlobalCrisisResources()).toEqual([
      { label: "Local line", contact: "555-0100" },
      { label: "", contact: "112" },
    ]);
  });

  it("saveProfileCrisisResources sets and clears the per-profile override", async () => {
    const login = createLogin();
    const profile = createProfile("crisis-override", login.id);
    actAs(login, profile);

    await saveProfileCrisisResources(
      fd({ crisis_resources: "My line | 555-0111" })
    );
    expect(getProfileCrisisResourcesOverride(profile.id)).toEqual([
      { label: "My line", contact: "555-0111" },
    ]);

    // Empty clears the override (inherit global).
    await saveProfileCrisisResources(fd({ crisis_resources: "  " }));
    expect(getProfileCrisisResourcesOverride(profile.id)).toBeNull();
  });
});
