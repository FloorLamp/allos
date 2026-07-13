// SERVER-ACTION TIER — immunization write path + per-vaccine overrides.
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
  updateImmunization,
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

  it("rejects an impossible date with a typed error, persisting nothing (issue #474)", async () => {
    const { profile } = seedActor();
    // A validation failure must reach the form as an explicit { ok:false, error }
    // — NOT an undefined resolve the form reads as "Saved ✓".
    const res = await addImmunization(
      fd({ date: "not-a-date", vaccine: "MMR" })
    );
    expect(res).toEqual({ ok: false, error: expect.any(String) });
    expect(immRows(profile.id)).toHaveLength(0);
  });

  it("rejects a blank vaccine with a typed error (issue #474)", async () => {
    const { profile } = seedActor();
    const res = await addImmunization(
      fd({ date: "2001-06-01", vaccine: "  " })
    );
    expect(res.ok).toBe(false);
    expect(immRows(profile.id)).toHaveLength(0);
  });

  it("confirms a persisted save with { ok:true } (issue #474)", async () => {
    seedActor();
    const res = await addImmunization(
      fd({ date: "2001-06-01", vaccine: "MMR" })
    );
    expect(res).toEqual({ ok: true });
  });
});

// #601: an edit round-trips the provider link through the NAME only. When two
// same-name providers exist the #534 ambiguity policy would coin a THIRD row and
// silently relink the record — from an edit that never touched the provider field.
// resolveProviderOnEdit keeps the loaded id unless the name actually changed.
describe("provider edit round-trip (#601)", () => {
  function newProvider(name: string, dedup: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO providers (name, type, dedup_key) VALUES (?, 'organization', ?)`
        )
        .run(name, dedup).lastInsertRowid
    );
  }
  function newImmunization(profileId: number, providerId: number): number {
    return Number(
      db
        .prepare(
          `INSERT INTO immunizations (profile_id, date, vaccine, dose_label, provider_id)
           VALUES (?, '2001-06-01', 'mmr', '1', ?)`
        )
        .run(profileId, providerId).lastInsertRowid
    );
  }
  const providerCount = () =>
    (db.prepare("SELECT COUNT(*) c FROM providers").get() as { c: number }).c;
  const linkOf = (immId: number) =>
    (
      db
        .prepare("SELECT provider_id FROM immunizations WHERE id = ?")
        .get(immId) as { provider_id: number | null }
    ).provider_id;

  it("keeps the existing link (no new provider) when an unrelated field is edited", async () => {
    const { profile } = seedActor();
    // Two providers share the name "Dr. Smith" — an ambiguous name under #534.
    const smith = newProvider("Dr. Smith", `smith-a-${Math.random()}`);
    newProvider("Dr. Smith", `smith-b-${Math.random()}`);
    const immId = newImmunization(profile.id, smith);
    const before = providerCount();

    // Edit only the notes; the untouched provider field round-trips its loaded id+name.
    await updateImmunization(
      fd({
        id: immId,
        date: "2001-06-01",
        vaccine: "mmr",
        notes: "corrected",
        provider: "Dr. Smith",
        provider_id: smith,
        provider_loaded: "Dr. Smith",
      })
    );

    // No junk duplicate coined, and the record still points at the original provider.
    expect(providerCount()).toBe(before);
    expect(linkOf(immId)).toBe(smith);
  });

  it("re-resolves when the provider name is actually changed", async () => {
    const { profile } = seedActor();
    const smith = newProvider("Dr. Smith", `smith-c-${Math.random()}`);
    newProvider("Dr. Smith", `smith-d-${Math.random()}`);
    const immId = newImmunization(profile.id, smith);
    const before = providerCount();

    // Change the provider to a brand-new name → it re-resolves (create-on-type).
    await updateImmunization(
      fd({
        id: immId,
        date: "2001-06-01",
        vaccine: "mmr",
        provider: "Dr. Jones",
        provider_id: smith,
        provider_loaded: "Dr. Smith",
      })
    );

    expect(providerCount()).toBe(before + 1);
    const now = linkOf(immId);
    expect(now).not.toBe(smith);
    const linkedName = (
      db.prepare("SELECT name FROM providers WHERE id = ?").get(now!) as {
        name: string;
      }
    ).name;
    expect(linkedName).toBe("Dr. Jones");
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
