// SERVER-ACTION TIER — the medication-link write paths (#1051 med↔prescriber, #1052
// med↔indication). Pins the auth-gated create/edit resolution (the picker resolves an
// INDIVIDUAL, never the org default; a free-text prescriber resolves an exact
// individual; the "For condition…" picker sets the indication) and the suggest-and-
// accept accept/decline persistence.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  addSupplement,
  updateSupplement,
} from "@/app/(app)/nutrition/supplement-actions";
import {
  acceptPrescriberLink,
  declinePrescriberLink,
  acceptIndicationLink,
  declineIndicationLink,
} from "@/app/(app)/medications/actions";
import { seedActor, fd } from "./harness";

beforeEach(() => vi.mocked(revalidatePath).mockClear());

function medRow(id: number) {
  return db
    .prepare(
      `SELECT provider_id, indication_condition_id, prescriber FROM intake_items WHERE id = ?`
    )
    .get(id) as {
    provider_id: number | null;
    indication_condition_id: number | null;
    prescriber: string | null;
  };
}
function lastMedId(profileId: number): number {
  return (
    db
      .prepare(
        `SELECT id FROM intake_items WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(profileId) as { id: number }
  ).id;
}
function insertCondition(profileId: number, name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO conditions (name, status, source, profile_id) VALUES (?, 'active', NULL, ?)`
      )
      .run(name, profileId).lastInsertRowid
  );
}

describe("#1051 med form picker resolves an INDIVIDUAL (not the org default)", () => {
  it("creates the prescriber provider as type='individual'", async () => {
    const { profile } = seedActor();
    const res = await addSupplement(
      fd({
        name: "Amoxicillin",
        kind: "medication",
        rx: "1",
        provider: "Dr. Rivera",
      })
    );
    expect(res.ok).toBe(true);
    const med = medRow(lastMedId(profile.id));
    expect(med.provider_id).not.toBeNull();
    const prov = db
      .prepare(`SELECT type, name FROM providers WHERE id = ?`)
      .get(med.provider_id) as { type: string; name: string };
    expect(prov.type).toBe("individual");
    expect(prov.name).toBe("Dr. Rivera");
  });

  it("falls back to resolving the free-text prescriber to an existing individual", async () => {
    const { profile } = seedActor();
    const drId = Number(
      db
        .prepare(
          `INSERT INTO providers (name, type, dedup_key) VALUES ('Dr. Okafor','individual','name:individual:dr. okafor')`
        )
        .run().lastInsertRowid
    );
    // No explicit picker value — the free-text prescriber resolves the individual.
    const res = await addSupplement(
      fd({
        name: "Amoxicillin",
        kind: "medication",
        rx: "1",
        prescriber: "Dr. Okafor",
      })
    );
    expect(res.ok).toBe(true);
    expect(medRow(lastMedId(profile.id)).provider_id).toBe(drId);
  });
});

describe("#1052 the 'For condition…' picker sets the indication", () => {
  it("links on add and can be changed/cleared on edit", async () => {
    const { profile } = seedActor();
    const condA = insertCondition(profile.id, "Otitis media");
    const condB = insertCondition(profile.id, "Hypertension");
    await addSupplement(
      fd({
        name: "Amoxicillin",
        kind: "medication",
        indication_condition_id: condA,
      })
    );
    const medId = lastMedId(profile.id);
    expect(medRow(medId).indication_condition_id).toBe(condA);

    // Edit → change to condB.
    await updateSupplement(
      fd({
        id: medId,
        name: "Amoxicillin",
        kind: "medication",
        indication_condition_id: condB,
      })
    );
    expect(medRow(medId).indication_condition_id).toBe(condB);

    // Edit → clear.
    await updateSupplement(
      fd({ id: medId, name: "Amoxicillin", kind: "medication" })
    );
    expect(medRow(medId).indication_condition_id).toBeNull();
  });

  it("ignores a foreign/invalid condition id", async () => {
    const { profile } = seedActor();
    await addSupplement(
      fd({
        name: "Amoxicillin",
        kind: "medication",
        indication_condition_id: 999999,
      })
    );
    expect(medRow(lastMedId(profile.id)).indication_condition_id).toBeNull();
  });
});

describe("#1051 prescriber suggest-and-accept persistence", () => {
  it("accept links; decline is remembered and refuses to re-fire", async () => {
    const { profile } = seedActor();
    const drId = Number(
      db
        .prepare(
          `INSERT INTO providers (name, type, dedup_key) VALUES ('Sarah Chen, MD','individual','name:individual:sarah chen, md')`
        )
        .run().lastInsertRowid
    );
    await addSupplement(
      fd({
        name: "Amoxicillin",
        kind: "medication",
        rx: "1",
        prescriber: "S. Chen",
      })
    );
    const medId = lastMedId(profile.id);
    // No exact match → unlinked; a suggestion exists (near-miss).
    expect(medRow(medId).provider_id).toBeNull();

    const declined = await declinePrescriberLink(
      fd({ med_id: medId, provider_id: drId })
    );
    expect(declined.ok).toBe(true);
    const decision = db
      .prepare(
        `SELECT decision FROM med_link_decisions WHERE profile_id = ? AND kind = 'prescriber'`
      )
      .get(profile.id) as { decision: string };
    expect(decision.decision).toBe("declined");

    const accepted = await acceptPrescriberLink(
      fd({ med_id: medId, provider_id: drId })
    );
    expect(accepted.ok).toBe(true);
    expect(medRow(medId).provider_id).toBe(drId);
  });
});

describe("#1052 indication suggest-and-accept persistence", () => {
  it("accept links; decline is remembered", async () => {
    const { profile } = seedActor();
    const condId = insertCondition(profile.id, "Migraine");
    await addSupplement(fd({ name: "Sumatriptan", kind: "medication" }));
    const medId = lastMedId(profile.id);

    const declined = await declineIndicationLink(
      fd({ med_id: medId, condition_id: condId })
    );
    expect(declined.ok).toBe(true);

    const accepted = await acceptIndicationLink(
      fd({ med_id: medId, condition_id: condId })
    );
    expect(accepted.ok).toBe(true);
    expect(medRow(medId).indication_condition_id).toBe(condId);
  });
});
