// SERVER-ACTION TIER — the write gates for condition laterality/severity/stage
// (#1403) and the family-history death facts + genetic axis (#1407).
//
// The actions own coercion and authorization: a posted value outside a CHECK set
// must land as UNSTATED rather than crashing the insert, an edit must be able to
// clear a side, a read-access session must not write at all, and one profile's edit
// must never reach another's row.

import { describe, it, expect } from "vitest";
import {
  addCondition,
  updateCondition,
} from "@/app/(app)/records/problems/conditions/actions";
import {
  addFamilyHistory,
  updateFamilyHistory,
} from "@/app/(app)/records/care/overview/family-history-actions";
import { getConditions, getFamilyHistory } from "@/lib/queries";
import { actAs, createLogin, createProfile, fd, seedActor } from "./harness";

function lastCondition(profileId: number) {
  const rows = getConditions(profileId);
  return rows[rows.length - 1];
}

describe("condition attributes — write path (#1403)", () => {
  it("stores a posted side, grade and stage", async () => {
    const { profile } = seedActor();
    const r = await addCondition(
      fd({
        name: "Osteoarthritis of knee",
        status: "active",
        laterality: "left",
        severity: "moderate",
        stage: "  ",
      })
    );
    expect(r.ok).toBe(true);
    const c = getConditions(profile.id).find((x) => x.laterality === "left")!;
    expect(c).toMatchObject({ severity: "moderate", stage: null });
  });

  it("drops an off-vocabulary value to unstated instead of failing the write", async () => {
    const { profile } = seedActor();
    const r = await addCondition(
      fd({
        name: "Cleft palate",
        status: "active",
        laterality: "sideways",
        severity: "grade 2",
      })
    );
    expect(r.ok).toBe(true);
    const c = lastCondition(profile.id);
    expect(c.laterality).toBeNull();
    expect(c.severity).toBeNull();
  });

  it("an edit can state a side and can clear it again", async () => {
    const { profile } = seedActor();
    await addCondition(fd({ name: "Rotator cuff tear", status: "active" }));
    const id = lastCondition(profile.id).id;

    await updateCondition(
      fd({
        id,
        name: "Rotator cuff tear",
        status: "active",
        laterality: "right",
        severity: "severe",
        stage: "II",
      })
    );
    expect(getConditions(profile.id).find((c) => c.id === id)).toMatchObject({
      laterality: "right",
      severity: "severe",
      stage: "II",
    });

    await updateCondition(
      fd({ id, name: "Rotator cuff tear", status: "active" })
    );
    const cleared = getConditions(profile.id).find((c) => c.id === id)!;
    expect(cleared.laterality).toBeNull();
    expect(cleared.severity).toBeNull();
    expect(cleared.stage).toBeNull();
  });

  it("refuses the write on a read-only session", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("READONLY-COND", login.id);
    actAs(login, profile, "read");
    await expect(
      addCondition(
        fd({ name: "Should not land", status: "active", laterality: "left" })
      )
    ).rejects.toThrow();
    expect(getConditions(profile.id)).toHaveLength(0);
  });
});

describe("family-history death facts + genetic axis — write path (#1407)", () => {
  it("stores the age/cause of death and the discriminator", async () => {
    const { profile } = seedActor();
    const r = await addFamilyHistory(
      fd({
        relation: "Father",
        condition: "Coronary artery disease",
        onset_age: 48,
        age_at_death: 52,
        cause_of_death: "Myocardial infarction",
        relation_type: "genetic",
      })
    );
    expect(r.ok).toBe(true);
    expect(getFamilyHistory(profile.id)[0]).toMatchObject({
      age_at_death: 52,
      cause_of_death: "Myocardial infarction",
      relation_type: "genetic",
      deceased: 1, // implied by the stated death facts
    });
  });

  it("stating a death fact marks the relative deceased without the checkbox", async () => {
    const { profile } = seedActor();
    await addFamilyHistory(
      fd({ relation: "Mother", condition: "Stroke", age_at_death: 79 })
    );
    expect(getFamilyHistory(profile.id)[0].deceased).toBe(1);
  });

  it("drops an off-vocabulary relation type / lineage to unstated", async () => {
    const { profile } = seedActor();
    const r = await addFamilyHistory(
      fd({
        relation: "Cousin",
        condition: "Asthma",
        relation_type: "foster",
        lineage: "mother's side",
      })
    );
    expect(r.ok).toBe(true);
    const f = getFamilyHistory(profile.id)[0];
    expect(f.relation_type).toBeNull();
    expect(f.lineage).toBeNull();
  });

  it("an edit can mark a relative non-genetic and can restore the default", async () => {
    const { profile } = seedActor();
    await addFamilyHistory(
      fd({ relation: "Father", condition: "Coronary artery disease" })
    );
    const id = getFamilyHistory(profile.id)[0].id;

    await updateFamilyHistory(
      fd({
        id,
        relation: "Father",
        condition: "Coronary artery disease",
        relation_type: "adopted",
      })
    );
    expect(getFamilyHistory(profile.id)[0].relation_type).toBe("adopted");

    await updateFamilyHistory(
      fd({ id, relation: "Father", condition: "Coronary artery disease" })
    );
    expect(getFamilyHistory(profile.id)[0].relation_type).toBeNull();
  });

  it("cannot edit another profile's row", async () => {
    const owner = seedActor({ profileName: "FH-OWNER" });
    await addFamilyHistory(
      fd({ relation: "Sister", condition: "Asthma", relation_type: "half" })
    );
    const id = getFamilyHistory(owner.profile.id)[0].id;

    const other = seedActor({ profileName: "FH-OTHER" });
    await updateFamilyHistory(
      fd({ id, relation: "Sister", condition: "Hijacked" })
    );
    // The row is untouched; nothing landed on the other profile either.
    expect(getFamilyHistory(owner.profile.id)[0]).toMatchObject({
      condition: "Asthma",
      relation_type: "half",
    });
    expect(getFamilyHistory(other.profile.id)).toHaveLength(0);
  });
});
