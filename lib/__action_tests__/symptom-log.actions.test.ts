// SERVER-ACTION TIER — symptom log write path (issue #799).
//
// Proves the real logSymptom/editSymptom/removeSymptom/rename/delete actions run through
// the (mocked) auth guard and enforce: worst-severity re-log (a tap only RAISES; an edit
// may LOWER), curated-vs-custom resolution, #203 custom rename/delete re-keying, the
// situations illness_type flag (built-in Illness on by default; user opt-in toggle), and
// per-profile scoping.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  logSymptom,
  editSymptom,
  lowerSymptom,
  setSymptomNote,
  removeSymptom,
  renameCustomSymptom,
  deleteCustomSymptom,
  activateIllnessForSymptoms,
} from "@/app/(app)/symptoms/actions";
import { toggleSituationIllnessType } from "@/app/(app)/nutrition/supplement-actions";
import {
  getSymptomsOnDate,
  getSymptomSeveritiesOnDate,
  getCustomSymptomNames,
} from "@/lib/queries";
import {
  getSituations,
  hasActiveIllnessSituation,
} from "@/lib/settings/profile-attrs";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
const DATE = "2026-07-08";
const DATE2 = "2026-07-09";

function rows(profileId: number) {
  return db
    .prepare(
      "SELECT date, symptom, severity FROM symptom_logs WHERE profile_id = ? ORDER BY date, symptom"
    )
    .all(profileId) as { date: string; symptom: string; severity: number }[];
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("logSymptom — worst-severity re-log", () => {
  it("a re-tap keeps the day's WORST severity (only raises)", async () => {
    const login = createLogin();
    const profile = createProfile("sick", login.id);
    actAs(login, profile);

    await logSymptom(fd({ symptom: "cough", severity: 2, date: DATE }));
    let res = await logSymptom(
      fd({ symptom: "cough", severity: 4, date: DATE })
    );
    expect(res).toMatchObject({ ok: true, symptom: "cough", severity: 4 });
    // A lower tap does NOT lower it.
    res = await logSymptom(fd({ symptom: "cough", severity: 1, date: DATE }));
    expect(res).toMatchObject({ ok: true, severity: 4 });

    const r = rows(profile.id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ symptom: "cough", severity: 4, date: DATE });
    expect(getSymptomSeveritiesOnDate(profile.id, DATE).cough).toBe(4);
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("editSymptom CAN lower the severity (explicit edit, not a tap)", async () => {
    const login = createLogin();
    const profile = createProfile("edit", login.id);
    actAs(login, profile);

    await logSymptom(fd({ symptom: "fever", severity: 4, date: DATE }));
    const res = await editSymptom(
      fd({ symptom: "fever", severity: 1, date: DATE })
    );
    expect(res).toMatchObject({ ok: true, severity: 1 });
    expect(getSymptomSeveritiesOnDate(profile.id, DATE).fever).toBe(1);
  });

  it("resolves a typed curated label onto its slug (never shadows the catalog)", async () => {
    const login = createLogin();
    const profile = createProfile("resolve", login.id);
    actAs(login, profile);
    const res = await logSymptom(
      fd({ symptom: "Fever", severity: 2, date: DATE })
    );
    expect(res).toMatchObject({ ok: true, symptom: "fever" });
    expect(rows(profile.id)[0].symptom).toBe("fever");
  });

  it("rejects an out-of-range severity", async () => {
    const login = createLogin();
    const profile = createProfile("bad", login.id);
    actAs(login, profile);
    const res = await logSymptom(
      fd({ symptom: "cough", severity: 9, date: DATE })
    );
    expect(res.ok).toBe(false);
    expect(rows(profile.id)).toEqual([]);
  });
});

describe("well-day symptom log (#1300) — no situation required or created", () => {
  it("logs a symptom with NO illness/situation activated or implied", async () => {
    const login = createLogin();
    const profile = createProfile("wellday", login.id);
    actAs(login, profile);

    // A well user with severe cramps and no illness/situation at all.
    expect(hasActiveIllnessSituation(profile.id)).toBe(false);
    const res = await logSymptom(
      fd({ symptom: "cramps", severity: 3, date: DATE })
    );
    expect(res).toMatchObject({ ok: true, symptom: "cramps", severity: 3 });

    // The symptom row exists — but NO situation vocabulary row and NO illness episode were
    // created; logging a symptom must not require, imply, or activate any situation.
    expect(rows(profile.id)).toHaveLength(1);
    expect(getSituations(profile.id)).toEqual([]);
    expect(hasActiveIllnessSituation(profile.id)).toBe(false);
    const episodes = db
      .prepare("SELECT COUNT(*) c FROM illness_episodes WHERE profile_id = ?")
      .get(profile.id) as { c: number };
    expect(episodes.c).toBe(0);
  });
});

describe("removeSymptom", () => {
  it("clears the day's row", async () => {
    const login = createLogin();
    const profile = createProfile("rm", login.id);
    actAs(login, profile);
    await logSymptom(fd({ symptom: "nausea", severity: 3, date: DATE }));
    await removeSymptom(fd({ symptom: "nausea", date: DATE }));
    expect(rows(profile.id)).toEqual([]);
  });
});

describe("custom symptoms — #203 name-keyed hygiene", () => {
  it("stores a custom name inline and lists it as a custom", async () => {
    const login = createLogin();
    const profile = createProfile("custom", login.id);
    actAs(login, profile);
    await logSymptom(fd({ symptom: "Migraine", severity: 3, date: DATE }));
    expect(rows(profile.id)[0].symptom).toBe("Migraine");
    expect(getCustomSymptomNames(profile.id)).toContain("Migraine");
    // A curated slug is NOT a custom.
    await logSymptom(fd({ symptom: "cough", severity: 1, date: DATE }));
    expect(getCustomSymptomNames(profile.id)).not.toContain("cough");
  });

  it("rename re-keys all rows and merges worst severity on a per-day collision", async () => {
    const login = createLogin();
    const profile = createProfile("rename", login.id);
    actAs(login, profile);
    await logSymptom(fd({ symptom: "Migraine", severity: 3, date: DATE }));
    await logSymptom(fd({ symptom: "Migraine", severity: 2, date: DATE2 }));
    // A collision target on DATE at a lower severity — the merge keeps the worst.
    await logSymptom(fd({ symptom: "Bad head", severity: 1, date: DATE }));

    const res = await renameCustomSymptom(
      fd({ from: "Migraine", to: "Bad head" })
    );
    expect(res.ok).toBe(true);

    const r = rows(profile.id);
    // No "Migraine" rows remain; DATE merged to severity 3, DATE2 re-keyed.
    expect(r.find((x) => x.symptom === "Migraine")).toBeUndefined();
    expect(
      r.find((x) => x.date === DATE && x.symptom === "Bad head")?.severity
    ).toBe(3);
    expect(
      r.find((x) => x.date === DATE2 && x.symptom === "Bad head")?.severity
    ).toBe(2);
  });

  it("delete removes every row for the custom symptom", async () => {
    const login = createLogin();
    const profile = createProfile("del", login.id);
    actAs(login, profile);
    await logSymptom(fd({ symptom: "Migraine", severity: 3, date: DATE }));
    await logSymptom(fd({ symptom: "Migraine", severity: 2, date: DATE2 }));
    const res = await deleteCustomSymptom(fd({ symptom: "Migraine" }));
    expect(res.ok).toBe(true);
    expect(rows(profile.id)).toEqual([]);
  });

  it("refuses to rename or delete a curated slug (not user-managed)", async () => {
    const login = createLogin();
    const profile = createProfile("guard", login.id);
    actAs(login, profile);
    await logSymptom(fd({ symptom: "cough", severity: 2, date: DATE }));
    const rn = await renameCustomSymptom(fd({ from: "cough", to: "hack" }));
    expect(rn.ok).toBe(false);
    const del = await deleteCustomSymptom(fd({ symptom: "cough" }));
    expect(del.ok).toBe(false);
    // The curated row survives.
    expect(rows(profile.id)[0].symptom).toBe("cough");
  });
});

describe("situations illness_type flag (#799)", () => {
  it("built-in Illness activates flagged, gating the dashboard card", async () => {
    const login = createLogin();
    const profile = createProfile("ill", login.id);
    actAs(login, profile);
    expect(hasActiveIllnessSituation(profile.id)).toBe(false);
    await activateIllnessForSymptoms();
    const illness = getSituations(profile.id).find((s) => s.name === "Illness");
    expect(illness?.active).toBe(1);
    expect(illness?.illness_type).toBe(1);
    expect(hasActiveIllnessSituation(profile.id)).toBe(true);
  });

  it("a user situation opts in / out via the bar toggle", async () => {
    const login = createLogin();
    const profile = createProfile("opt", login.id);
    actAs(login, profile);
    await toggleSituationIllnessType(fd({ situation: "Migraine" }));
    expect(
      getSituations(profile.id).find((s) => s.name === "Migraine")?.illness_type
    ).toBe(1);
    await toggleSituationIllnessType(fd({ situation: "Migraine" }));
    expect(
      getSituations(profile.id).find((s) => s.name === "Migraine")?.illness_type
    ).toBe(0);
  });
});

describe("lowerSymptom — explicit lower (#857)", () => {
  it("lowers an existing symptom-day's worst severity", async () => {
    const login = createLogin();
    const profile = createProfile("lower", login.id);
    actAs(login, profile);

    await logSymptom(fd({ symptom: "cough", severity: 4, date: DATE }));
    const res = await lowerSymptom(
      fd({ symptom: "cough", severity: 1, date: DATE })
    );
    expect(res).toMatchObject({ ok: true, symptom: "cough", severity: 1 });
    expect(getSymptomSeveritiesOnDate(profile.id, DATE)).toEqual({ cough: 1 });
  });

  it("refuses to RAISE — only the tap path raises", async () => {
    const login = createLogin();
    const profile = createProfile("lower-guard", login.id);
    actAs(login, profile);

    await logSymptom(fd({ symptom: "cough", severity: 2, date: DATE }));
    const res = await lowerSymptom(
      fd({ symptom: "cough", severity: 4, date: DATE })
    );
    expect(res).toMatchObject({ ok: false });
    // Unchanged at the logged worst.
    expect(getSymptomSeveritiesOnDate(profile.id, DATE)).toEqual({ cough: 2 });
  });

  it("preserves the day's note when lowering", async () => {
    const login = createLogin();
    const profile = createProfile("lower-note", login.id);
    actAs(login, profile);

    await logSymptom(
      fd({ symptom: "cough", severity: 4, date: DATE, note: "worse at night" })
    );
    await lowerSymptom(fd({ symptom: "cough", severity: 2, date: DATE }));
    const [row] = getSymptomsOnDate(profile.id, DATE);
    expect(row).toMatchObject({ severity: 2, note: "worse at night" });
  });

  it("a plain re-tap still only RAISES (worst-severity), never lowers", async () => {
    const login = createLogin();
    const profile = createProfile("tap-raise", login.id);
    actAs(login, profile);

    await logSymptom(fd({ symptom: "cough", severity: 3, date: DATE }));
    await logSymptom(fd({ symptom: "cough", severity: 1, date: DATE }));
    expect(getSymptomSeveritiesOnDate(profile.id, DATE)).toEqual({ cough: 3 });
  });
});

describe("setSymptomNote — per-symptom note affordance (#857)", () => {
  it("sets and clears a note without touching severity", async () => {
    const login = createLogin();
    const profile = createProfile("note", login.id);
    actAs(login, profile);

    await logSymptom(fd({ symptom: "cough", severity: 3, date: DATE }));
    let res = await setSymptomNote(
      fd({ symptom: "cough", date: DATE, note: "dry, worse at night" })
    );
    expect(res).toMatchObject({ ok: true, severity: 3 });
    let [row] = getSymptomsOnDate(profile.id, DATE);
    expect(row).toMatchObject({ severity: 3, note: "dry, worse at night" });

    // A blank note clears it, leaving severity intact.
    res = await setSymptomNote(fd({ symptom: "cough", date: DATE, note: "" }));
    expect(res).toMatchObject({ ok: true });
    [row] = getSymptomsOnDate(profile.id, DATE);
    expect(row).toMatchObject({ severity: 3, note: null });
  });

  it("refuses to annotate a symptom with no logged row", async () => {
    const login = createLogin();
    const profile = createProfile("note-empty", login.id);
    actAs(login, profile);

    const res = await setSymptomNote(
      fd({ symptom: "cough", date: DATE, note: "hi" })
    );
    expect(res).toMatchObject({ ok: false });
    expect(getSymptomsOnDate(profile.id, DATE)).toEqual([]);
  });
});

describe("profile scoping", () => {
  it("one profile's symptoms never appear in another's", async () => {
    const a = createLogin();
    const pa = createProfile("a", a.id);
    actAs(a, pa);
    await logSymptom(fd({ symptom: "cough", severity: 2, date: DATE }));

    const b = createLogin();
    const pb = createProfile("b", b.id);
    actAs(b, pb);
    expect(getSymptomsOnDate(pb.id, DATE)).toEqual([]);
    expect(getSymptomsOnDate(pa.id, DATE)).toHaveLength(1);
  });
});
