// SERVER-ACTION TIER — cross-profile illness-hero writes (issue #858).
//
// The illness hero lets a caregiver log a household member's symptom / temperature / PRN
// dose and end their episode WITHOUT switching the acting profile. The bar/control post an
// explicit `profileId`; the action then gates on the TARGET via requireProfileWriteAccess
// (the #31 cross-profile gate) instead of the active-profile requireWriteAccess. This tier
// pins that gate: a GRANTED member writes the target's rows; an UNGRANTED (or read-only)
// member is refused before any write. Auth is mocked (harness), the DB is real.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { logSymptom, logTemperature } from "@/app/(app)/symptoms/actions";
import { logMedicationAdministration } from "@/app/(app)/medications/actions";
import {
  endEpisodeAction,
  editEpisodeAction,
  promoteEpisodeToConditionAction,
  createEpisodeShareLinkAction,
} from "@/app/(app)/medical/episodes/actions";
import { logSymptomCore } from "@/lib/symptom-log-write";
import { resolveSituationId } from "@/lib/settings";
import { getEpisodeRow, getOpenEpisodeRow } from "@/lib/illness-episode-store";
import { getShareLinkByToken } from "@/lib/share-links-db";
import { shiftDateStr } from "@/lib/date";
import { createLogin, createProfile, actAs, fd } from "./harness";

// A PRN medication (as_needed=1) owned by `profileId`, for the administration path.
function seedPrnMed(profileId: number): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed, quantity_on_hand, qty_per_dose)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'high', 1, 10, 1)`
      )
      .run(profileId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '400 mg', 'any', 'any', 0)`
  ).run(itemId);
  return itemId;
}

// Make `profileId` currently sick with an ongoing Illness episode ROW; return its id.
function makeSick(profileId: number): number {
  resolveSituationId(profileId, "Illness");
  db.prepare(
    `UPDATE situations SET active = 1 WHERE profile_id = ? AND name = 'Illness'`
  ).run(profileId);
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(profileId, shiftDateStr(today(profileId), -2));
  logSymptomCore(profileId, "cough", 2, today(profileId));
  return getOpenEpisodeRow(profileId, "Illness")!.id;
}

function symptomCount(profileId: number, symptom: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM symptom_logs WHERE profile_id = ? AND symptom = ?"
      )
      .get(profileId, symptom) as { c: number }
  ).c;
}

function tempCount(profileId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM medical_records WHERE profile_id = ? AND value_num IS NOT NULL"
      )
      .get(profileId) as { c: number }
  ).c;
}

function adminCount(itemId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS c FROM intake_item_logs WHERE item_id = ? AND status = 'taken'"
      )
      .get(itemId) as { c: number }
  ).c;
}

// A member acting as their OWN base profile, granted WRITE on `kid`, no grant on
// `stranger`, and a read-only grant on `readonly` — the three cases the gate must sort.
function household() {
  const login = createLogin({ role: "member" });
  const home = createProfile("Caregiver Home", login.id);
  const kid = createProfile("Sick Kid", login.id); // write grant (default)
  const stranger = createProfile("Stranger Kid"); // no grant
  const readonly = createProfile("Readonly Kid", login.id);
  db.prepare(
    "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
  ).run(login.id, readonly.id);
  actAs(login, home); // acting as the base profile, NOT a kid
  return { login, home, kid, stranger, readonly };
}

describe("cross-profile symptom writes (#858)", () => {
  it("logs a symptom for a granted household member without switching", async () => {
    const { kid, home } = household();
    const res = await logSymptom(
      fd({ symptom: "cough", severity: 2, profileId: kid.id })
    );
    expect(res.ok).toBe(true);
    expect(symptomCount(kid.id, "cough")).toBe(1);
    // The acting profile was NOT written — the target was the kid.
    expect(symptomCount(home.id, "cough")).toBe(0);
  });

  it("refuses a symptom write to an ungranted profile", async () => {
    const { stranger } = household();
    await expect(
      logSymptom(fd({ symptom: "cough", severity: 2, profileId: stranger.id }))
    ).rejects.toThrow(/not accessible/);
    expect(symptomCount(stranger.id, "cough")).toBe(0);
  });

  it("refuses a cross-profile write on a read-only grant", async () => {
    const { readonly } = household();
    await expect(
      logSymptom(fd({ symptom: "cough", severity: 2, profileId: readonly.id }))
    ).rejects.toThrow(/read-only/);
    expect(symptomCount(readonly.id, "cough")).toBe(0);
  });

  it("still writes the ACTIVE profile when no profileId is posted", async () => {
    const { home } = household();
    const res = await logSymptom(fd({ symptom: "cough", severity: 1 }));
    expect(res.ok).toBe(true);
    expect(symptomCount(home.id, "cough")).toBe(1);
  });
});

describe("cross-profile temperature writes (#858)", () => {
  it("logs a temperature for a granted member", async () => {
    const { kid } = household();
    const res = await logTemperature(
      fd({ temperature: 101.2, temp_unit: "F", profileId: kid.id })
    );
    expect(res.ok).toBe(true);
    expect(tempCount(kid.id)).toBe(1);
  });

  it("refuses a temperature write to an ungranted profile", async () => {
    const { stranger } = household();
    await expect(
      logTemperature(
        fd({ temperature: 101.2, temp_unit: "F", profileId: stranger.id })
      )
    ).rejects.toThrow(/not accessible/);
    expect(tempCount(stranger.id)).toBe(0);
  });
});

describe("cross-profile PRN administration (#858)", () => {
  it("logs a dose for a granted member", async () => {
    const { kid } = household();
    const itemId = seedPrnMed(kid.id);
    const res = await logMedicationAdministration(
      fd({ id: itemId, offset: "now", profileId: kid.id })
    );
    expect(res.ok).toBe(true);
    expect(adminCount(itemId)).toBe(1);
  });

  it("refuses a dose write to an ungranted profile", async () => {
    const { stranger } = household();
    const itemId = seedPrnMed(stranger.id);
    await expect(
      logMedicationAdministration(
        fd({ id: itemId, offset: "now", profileId: stranger.id })
      )
    ).rejects.toThrow(/not accessible/);
    expect(adminCount(itemId)).toBe(0);
  });
});

describe("cross-profile end-episode (#858)", () => {
  it("ends a granted member's episode without switching", async () => {
    const { kid } = household();
    const episodeId = makeSick(kid.id);
    const res = await endEpisodeAction(fd({ episodeId, profileId: kid.id }));
    expect(res.ok).toBe(true);
    expect(getOpenEpisodeRow(kid.id, "Illness")).toBeNull();
  });

  it("refuses ending an ungranted profile's episode", async () => {
    const { stranger } = household();
    const episodeId = makeSick(stranger.id);
    await expect(
      endEpisodeAction(fd({ episodeId, profileId: stranger.id }))
    ).rejects.toThrow(/not accessible/);
    expect(getOpenEpisodeRow(stranger.id, "Illness")).not.toBeNull();
  });
});

// The cross-profile EPISODE-PAGE writes (#879): the caregiver opens a household member's
// full episode page from the hero link and edits/promotes/shares it WITHOUT switching.
// Each posts the target `profileId`; the gate is the #31 cross-profile gate.
describe("cross-profile episode edit (#879)", () => {
  it("edits a granted member's episode note/outcome without switching", async () => {
    const { kid } = household();
    const episodeId = makeSick(kid.id);
    const res = await editEpisodeAction(
      fd({
        episodeId,
        profileId: kid.id,
        note: "pediatrician said rest",
        outcome: "self-resolved",
      })
    );
    expect(res.ok).toBe(true);
    const row = getEpisodeRow(kid.id, episodeId)!;
    expect(row.note).toBe("pediatrician said rest");
    expect(row.outcome).toBe("self-resolved");
  });

  it("refuses editing an ungranted profile's episode", async () => {
    const { stranger } = household();
    const episodeId = makeSick(stranger.id);
    await expect(
      editEpisodeAction(fd({ episodeId, profileId: stranger.id, note: "x" }))
    ).rejects.toThrow(/not accessible/);
    expect(getEpisodeRow(stranger.id, episodeId)!.note).toBeNull();
  });

  it("refuses editing on a read-only grant", async () => {
    const { readonly } = household();
    const episodeId = makeSick(readonly.id);
    await expect(
      editEpisodeAction(fd({ episodeId, profileId: readonly.id, note: "x" }))
    ).rejects.toThrow(/read-only/);
    expect(getEpisodeRow(readonly.id, episodeId)!.note).toBeNull();
  });
});

describe("cross-profile promote-to-condition (#879)", () => {
  function conditionCount(profileId: number): number {
    return (
      db
        .prepare("SELECT COUNT(*) AS c FROM conditions WHERE profile_id = ?")
        .get(profileId) as { c: number }
    ).c;
  }

  it("promotes a granted member's episode to a condition", async () => {
    const { kid } = household();
    const episodeId = makeSick(kid.id);
    const res = await promoteEpisodeToConditionAction(
      fd({ episodeId, profileId: kid.id })
    );
    expect(res.ok).toBe(true);
    expect(conditionCount(kid.id)).toBe(1);
  });

  it("refuses promoting an ungranted profile's episode", async () => {
    const { stranger } = household();
    const episodeId = makeSick(stranger.id);
    await expect(
      promoteEpisodeToConditionAction(fd({ episodeId, profileId: stranger.id }))
    ).rejects.toThrow(/not accessible/);
    expect(conditionCount(stranger.id)).toBe(0);
  });
});

describe("cross-profile episode share link (#879, write-gated)", () => {
  it("mints a share link for a granted (write) member's episode", async () => {
    const { kid } = household();
    const episodeId = makeSick(kid.id);
    const res = await createEpisodeShareLinkAction(
      fd({ episodeId, profileId: kid.id, ttl: "7d" })
    );
    expect(res.ok).toBe(true);
    const token = res.ok ? res.path.replace("/share/", "") : "";
    const link = getShareLinkByToken(token);
    expect(link).not.toBeNull();
    expect(link!.profile_id).toBe(kid.id);
  });

  it("refuses minting a share link on a read-only grant (conservative default)", async () => {
    const { readonly } = household();
    const episodeId = makeSick(readonly.id);
    await expect(
      createEpisodeShareLinkAction(
        fd({ episodeId, profileId: readonly.id, ttl: "7d" })
      )
    ).rejects.toThrow(/read-only/);
  });
});
