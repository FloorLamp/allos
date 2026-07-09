// SERVER-ACTION TIER — immunization write path + per-vaccine overrides (#155).
//
// Adds a dose, then exercises the override lifecycle via assessSchedule: an
// 'immune' override completes a series, a 'declined' override drops a vaccine from
// needs-attention, and clearing reverts. Mirrors the query smoke test's use of
// assessSchedule so the assertions reflect the same status machinery the UI reads.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addImmunization,
  setImmunizationOverride,
  clearImmunizationOverride,
} from "@/app/(app)/immunizations/actions";
import { getImmunizations, getImmunizationOverrides } from "@/lib/queries";
import { assessSchedule } from "@/lib/immunization-status";
import { seedActor, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

function immRows(profileId: number) {
  return db
    .prepare(
      "SELECT id, date, vaccine, dose_label FROM immunizations WHERE profile_id = ? ORDER BY id"
    )
    .all(profileId) as {
    id: number;
    date: string;
    vaccine: string;
    dose_label: string | null;
  }[];
}

// Assess a profile's schedule at ~40y with no titers, returning the per-vaccine map.
function assess(profileId: number, on = "2026-01-01") {
  const records = getImmunizations(profileId).map((r) => ({
    vaccine: r.vaccine,
    date: r.date,
  }));
  const overrides = getImmunizationOverrides(profileId).map((o) => ({
    vaccine: o.vaccine,
    kind: o.kind,
  }));
  return assessSchedule(records, 40 * 12, null, on, [], overrides);
}

beforeEach(() => revalidate.mockClear());

describe("addImmunization", () => {
  it("stores a dose with the vaccine normalized to a catalog code", async () => {
    const { profile } = seedActor();
    // "MMR" normalizes to the catalog code 'mmr'.
    await addImmunization(
      fd({ date: "2001-06-01", vaccine: "MMR", dose_label: "1" })
    );

    const rows = immRows(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].vaccine).toBe("mmr");
    expect(rows[0].dose_label).toBe("1");
    expect(revalidate).toHaveBeenCalledWith("/immunizations");
  });

  it("rejects an impossible date", async () => {
    const { profile } = seedActor();
    await addImmunization(fd({ date: "not-a-date", vaccine: "MMR" }));
    expect(immRows(profile.id)).toHaveLength(0);
  });
});

describe("override lifecycle", () => {
  it("'immune' override marks a series complete; clearing reverts", async () => {
    const { profile } = seedActor();
    // Pick a vaccine with no doses so status is naturally incomplete.
    const before = assess(profile.id).assessments.find((a) => a.code === "mmr");
    expect(before).toBeDefined();
    expect(before!.override).toBeNull();

    await setImmunizationOverride(fd({ vaccine: "mmr", kind: "immune" }));
    const overrides = getImmunizationOverrides(profile.id);
    expect(overrides.find((o) => o.vaccine === "mmr")?.kind).toBe("immune");

    const immune = assess(profile.id).assessments.find((a) => a.code === "mmr");
    expect(immune!.override).toBe("immune");
    expect(immune!.status).toBe("complete");

    await clearImmunizationOverride(fd({ vaccine: "mmr" }));
    expect(getImmunizationOverrides(profile.id)).toHaveLength(0);
    const reverted = assess(profile.id).assessments.find(
      (a) => a.code === "mmr"
    );
    expect(reverted!.override).toBeNull();
    expect(reverted!.status).not.toBe("complete");
  });

  it("'declined' override drops a vaccine from needs-attention", async () => {
    const { profile } = seedActor();
    // Establish the un-overridden baseline status for hpv (something active —
    // due/overdue/unknown/not_recommended — but not the terminal 'declined').
    const baseline = assess(profile.id).assessments.find(
      (a) => a.code === "hpv"
    );
    expect(baseline?.status).not.toBe("declined");

    await setImmunizationOverride(
      fd({ vaccine: "hpv", kind: "declined", reason: "personal choice" })
    );

    const hpv = assess(profile.id).assessments.find((a) => a.code === "hpv");
    // A declined vaccine reads a terminal, muted status — excluded from the
    // due/overdue "needs attention" buckets by construction.
    expect(hpv?.status).toBe("declined");
    expect(hpv?.override).toBe("declined");
    expect(["due", "overdue"]).not.toContain(hpv?.status);
  });

  it("re-setting an override flips the kind (upsert on profile_id+vaccine)", async () => {
    const { profile } = seedActor();
    await setImmunizationOverride(fd({ vaccine: "hpv", kind: "declined" }));
    await setImmunizationOverride(fd({ vaccine: "hpv", kind: "immune" }));
    const overrides = getImmunizationOverrides(profile.id);
    expect(overrides).toHaveLength(1);
    expect(overrides[0].kind).toBe("immune");
  });

  it("override is scoped to the acting profile", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("ImmB", login.id);

    actAs(login, profileA);
    await setImmunizationOverride(fd({ vaccine: "hpv", kind: "declined" }));

    expect(getImmunizationOverrides(profileB.id)).toHaveLength(0);
    expect(getImmunizationOverrides(profileA.id)).toHaveLength(1);
  });
});
