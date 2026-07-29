// SERVER-ACTION TIER — the records-safety / passport-completeness write paths
// (#1396 instrument correction, #1405 allergy safety attributes, #1406 immunization
// administration attributes).
//
// The action layer is the auth + validation boundary, so this is where the questions
// the lib cores can't answer live: does a cross-profile id get refused, does an
// out-of-range total get refused, does an unknown vocabulary value land as NULL
// instead of reaching a CHECK and 500-ing, and does a refusable write answer with a
// typed outcome rather than a silent success.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  recordInstrumentAction,
  updateInstrumentAction,
  deleteInstrumentAction,
} from "@/app/(app)/medical/instruments/actions";
import {
  addAllergy,
  updateAllergy,
} from "@/app/(app)/records/problems/allergies/actions";
import {
  addImmunization,
  updateImmunization,
  setImmunizationOverride,
} from "@/app/(app)/immunizations/actions";
import { getAllergies } from "@/lib/queries";
import { getImmunizationOverride } from "@/lib/queries";
import { actAs, createLogin, createProfile, fd } from "./harness";

function latestScoreId(profileId: number): number {
  const row = db
    .prepare(
      `SELECT id FROM medical_records
        WHERE profile_id = ? AND category = 'instrument' ORDER BY id DESC LIMIT 1`
    )
    .get(profileId) as { id: number };
  return row.id;
}

describe("instrument score correction (#1396)", () => {
  it("corrects a mis-typed outside total, and the stored reading follows", async () => {
    const login = createLogin();
    const profile = createProfile("score-fix", login.id);
    actAs(login, profile);

    expect(
      (
        await recordInstrumentAction(
          fd({
            instrument: "GAD-7",
            mode: "outside",
            date: "2020-04-05",
            total: "21",
          })
        )
      ).ok
    ).toBe(true);
    const id = latestScoreId(profile.id);

    const r = await updateInstrumentAction(
      fd({ id: String(id), date: "2020-04-05", total: "12" })
    );
    expect(r.ok).toBe(true);
    const row = db
      .prepare("SELECT value_num, value FROM medical_records WHERE id = ?")
      .get(id) as { value_num: number; value: string };
    expect(row.value_num).toBe(12);
    expect(row.value).toBe("12");
  });

  it("refuses a total outside the instrument's own range", async () => {
    const login = createLogin();
    const profile = createProfile("score-range", login.id);
    actAs(login, profile);
    await recordInstrumentAction(
      fd({
        instrument: "GAD-7",
        mode: "outside",
        date: "2020-04-05",
        total: "9",
      })
    );
    const id = latestScoreId(profile.id);
    // 22 is above GAD-7's maximum of 21 — validated against the TARGET ROW's
    // instrument, not a posted one.
    const r = await updateInstrumentAction(
      fd({ id: String(id), date: "2020-04-05", total: "22" })
    );
    expect(r.ok).toBe(false);
    expect(
      (
        db
          .prepare("SELECT value_num FROM medical_records WHERE id = ?")
          .get(id) as {
          value_num: number;
        }
      ).value_num
    ).toBe(9);
  });

  it("refuses another profile's score, and deletes return no undo token", async () => {
    const ownerLogin = createLogin();
    const owner = createProfile("score-owner", ownerLogin.id);
    actAs(ownerLogin, owner);
    await recordInstrumentAction(
      fd({
        instrument: "PHQ-9",
        mode: "outside",
        date: "2020-04-05",
        total: "20",
      })
    );
    const id = latestScoreId(owner.id);

    const otherLogin = createLogin({ role: "member" });
    const other = createProfile("score-other", otherLogin.id);
    actAs(otherLogin, other);

    expect(
      (
        await updateInstrumentAction(
          fd({ id: String(id), date: "2020-04-05", total: "1" })
        )
      ).ok
    ).toBe(false);
    expect(await deleteInstrumentAction(fd({ id: String(id) }))).toEqual({
      undoId: null,
    });
    expect(
      (
        db
          .prepare("SELECT value_num FROM medical_records WHERE id = ?")
          .get(id) as {
          value_num: number;
        }
      ).value_num
    ).toBe(20);
  });

  it("deleting returns an undo token so the toast can restore it", async () => {
    const login = createLogin();
    const profile = createProfile("score-undo", login.id);
    actAs(login, profile);
    await recordInstrumentAction(
      fd({
        instrument: "PHQ-9",
        mode: "outside",
        date: "2020-04-05",
        total: "20",
      })
    );
    const id = latestScoreId(profile.id);
    const { undoId } = await deleteInstrumentAction(fd({ id: String(id) }));
    expect(typeof undoId).toBe("number");
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM medical_records WHERE id = ?")
        .get(id)
    ).toEqual({ n: 0 });
  });
});

describe("allergy safety attributes (#1405)", () => {
  it("stores criticality, verification status, and multiple graded reactions", async () => {
    const login = createLogin();
    const profile = createProfile("allergy-safety", login.id);
    actAs(login, profile);

    const form = new FormData();
    form.set("substance", "Peanut");
    form.set("criticality", "high");
    form.set("verification_status", "confirmed");
    form.append("reaction_manifestation", "Hives");
    form.append("reaction_severity", "moderate");
    form.append("reaction_manifestation", "Anaphylaxis");
    form.append("reaction_severity", "severe");
    expect((await addAllergy(form)).ok).toBe(true);

    const [stored] = getAllergies(profile.id);
    expect(stored.criticality).toBe("high");
    expect(stored.verification_status).toBe("confirmed");
    // The parent keeps the CACHED first manifestation…
    expect(stored.reaction).toBe("Hives");
    expect(stored.severity).toBe("moderate");
    // …and the composed list carries both.
    expect(stored.reactions).toEqual([
      { manifestation: "Hives", severity: "moderate" },
      { manifestation: "Anaphylaxis", severity: "severe" },
    ]);
  });

  it("an unknown criticality / verification value lands as NULL, never at the CHECK", async () => {
    const login = createLogin();
    const profile = createProfile("allergy-junk", login.id);
    actAs(login, profile);
    const form = new FormData();
    form.set("substance", "Latex");
    form.set("criticality", "catastrophic");
    form.set("verification_status", "probably");
    expect((await addAllergy(form)).ok).toBe(true);
    const [stored] = getAllergies(profile.id);
    expect(stored.criticality).toBeNull();
    expect(stored.verification_status).toBeNull();
  });

  it("editing replaces the manifestation list and re-syncs the cached first row", async () => {
    const login = createLogin();
    const profile = createProfile("allergy-edit", login.id);
    actAs(login, profile);
    const add = new FormData();
    add.set("substance", "Shellfish");
    add.append("reaction_manifestation", "Hives");
    add.append("reaction_severity", "mild");
    add.append("reaction_manifestation", "Swelling");
    add.append("reaction_severity", "moderate");
    await addAllergy(add);
    const [before] = getAllergies(profile.id);

    const edit = new FormData();
    edit.set("id", String(before.id));
    edit.set("substance", "Shellfish");
    edit.set("verification_status", "refuted");
    edit.append("reaction_manifestation", "Swelling");
    edit.append("reaction_severity", "severe");
    expect((await updateAllergy(edit)).ok).toBe(true);

    const [after] = getAllergies(profile.id);
    expect(after.reactions).toEqual([
      { manifestation: "Swelling", severity: "severe" },
    ]);
    expect(after.reaction).toBe("Swelling");
    expect(after.severity).toBe("severe");
    expect(after.verification_status).toBe("refuted");
  });

  it("refuses an edit targeting another profile's allergy, with a typed error", async () => {
    const ownerLogin = createLogin();
    const owner = createProfile("allergy-owner", ownerLogin.id);
    actAs(ownerLogin, owner);
    const add = new FormData();
    add.set("substance", "Penicillin");
    await addAllergy(add);
    const [row] = getAllergies(owner.id);

    const otherLogin = createLogin({ role: "member" });
    const other = createProfile("allergy-other", otherLogin.id);
    actAs(otherLogin, other);
    const edit = new FormData();
    edit.set("id", String(row.id));
    edit.set("substance", "Hijacked");
    const r = await updateAllergy(edit);
    expect(r.ok).toBe(false);
    expect(getAllergies(owner.id)[0].substance).toBe("Penicillin");
  });
});

describe("immunization administration attributes (#1406)", () => {
  it("stores lot / route / site / reaction, and normalizes an unknown route to NULL", async () => {
    const login = createLogin();
    const profile = createProfile("imm-admin", login.id);
    actAs(login, profile);

    expect(
      (
        await addImmunization(
          fd({
            vaccine: "Tdap",
            date: "2020-08-09",
            lot_number: "lot-test-batch-42",
            route: "intramuscular",
            site: "Left deltoid",
            reaction: "Sore arm for two days",
          })
        )
      ).ok
    ).toBe(true);
    const row = db
      .prepare(
        `SELECT id, lot_number, route, site, reaction FROM immunizations
          WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
      )
      .get(profile.id) as {
      id: number;
      lot_number: string;
      route: string;
      site: string;
      reaction: string;
    };
    expect(row.lot_number).toBe("lot-test-batch-42");
    expect(row.route).toBe("intramuscular");
    expect(row.site).toBe("Left deltoid");
    expect(row.reaction).toBe("Sore arm for two days");

    // An unrecognized route must land as NULL — never at the CHECK.
    expect(
      (
        await updateImmunization(
          fd({
            id: String(row.id),
            vaccine: "Tdap",
            date: "2020-08-09",
            route: "telepathic",
          })
        )
      ).ok
    ).toBe(true);
    expect(
      (
        db
          .prepare("SELECT route FROM immunizations WHERE id = ?")
          .get(row.id) as {
          route: string | null;
        }
      ).route
    ).toBeNull();
  });

  it("stores a structured exemption type on a declination, and forces it NULL for 'immune'", async () => {
    const login = createLogin();
    const profile = createProfile("imm-exempt", login.id);
    actAs(login, profile);

    await setImmunizationOverride(
      fd({
        vaccine: "mmr",
        kind: "declined",
        exemption_type: "religious",
        reason: "Personal choice",
      })
    );
    expect(getImmunizationOverride(profile.id, "mmr")?.exemption_type).toBe(
      "religious"
    );

    // Flipping the same vaccine to 'immune' must not carry the exemption over —
    // an "immune" override is not an exemption.
    await setImmunizationOverride(
      fd({ vaccine: "mmr", kind: "immune", exemption_type: "religious" })
    );
    const after = getImmunizationOverride(profile.id, "mmr");
    expect(after?.kind).toBe("immune");
    expect(after?.exemption_type).toBeNull();
  });
});
