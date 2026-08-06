// SERVER-ACTION TIER — the "Needs attention" hero's per-item controls (issue #171).
//
// snoozeAttention / dismissAttention / markAttentionDose wrap the shared findings
// suppression + dose-confirm writers, revalidating the dashboard (and Upcoming) so a
// snooze/dismiss/mark on the hero matches the Upcoming page exactly. These assert the
// suppression row lands under the acting profile, the day-clamp holds, and the mark
// path is idempotent/profile-scoped.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import {
  snoozeAttention,
  dismissAttention,
  markAttentionDose,
} from "@/app/(app)/actions";
import { getFindingSuppressions, getTakenDoseIds } from "@/lib/queries";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { seedActor, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => revalidate.mockClear());

// A supplement + one daily dose for the acting profile, returning the dose id.
function seedDose(profileId: number): number {
  const suppId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active)
         VALUES (?, 'Vitamin D', 'supplement', 1)`
      )
      .run(profileId).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1000 IU', 'morning', 'any', 0)`
      )
      .run(suppId).lastInsertRowid
  );
}

describe("snoozeAttention", () => {
  it("snoozes a finding under the acting profile and revalidates the dashboard", async () => {
    const { profile } = seedActor();
    await snoozeAttention(fd({ signal_key: "dose:5", days: 7 }));

    const map = getFindingSuppressions(profile.id);
    const rec = map.get("dose:5");
    expect(rec).toBeTruthy();
    expect(rec!.snooze_until).toBe(shiftDateStr(today(profile.id), 7));
    expect(revalidate).toHaveBeenCalledWith("/");
    expect(revalidate).toHaveBeenCalledWith("/upcoming");
  });

  it("ignores a missing key or a non-positive day count", async () => {
    const { profile } = seedActor();
    await snoozeAttention(fd({ signal_key: "", days: 3 }));
    await snoozeAttention(fd({ signal_key: "dose:1", days: 0 }));
    expect(getFindingSuppressions(profile.id).size).toBe(0);
  });
});

describe("dismissAttention", () => {
  it("dismisses a finding (dismissed_at set) under the acting profile", async () => {
    const { profile } = seedActor();
    await dismissAttention(fd({ signal_key: "biomarker:ldl" }));
    const rec = getFindingSuppressions(profile.id).get("biomarker:ldl");
    expect(rec?.dismissed_at).toBeTruthy();
    expect(rec?.snooze_until).toBeNull();
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("is scoped to the acting profile", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("Other", login.id);

    actAs(login, profileA);
    await dismissAttention(fd({ signal_key: "dose:9" }));

    expect(getFindingSuppressions(profileA.id).has("dose:9")).toBe(true);
    expect(getFindingSuppressions(profileB.id).has("dose:9")).toBe(false);
  });
});

describe("markAttentionDose", () => {
  it("logs a due dose for today (idempotent) and revalidates the dashboard", async () => {
    const { profile } = seedActor();
    const doseId = seedDose(profile.id);

    // The action carries markDoseTaken's typed outcome (#2106) — the hero renders
    // from it, so the success wording and the idempotent repeat are both stated.
    expect(await markAttentionDose(fd({ dose_id: doseId }))).toEqual({
      ok: true,
      outcome: "logged",
    });
    expect(getTakenDoseIds(profile.id, today(profile.id)).has(doseId)).toBe(
      true
    );
    // second call is a no-op (per-day dedup), still safe — and says so
    expect(await markAttentionDose(fd({ dose_id: doseId }))).toEqual({
      ok: true,
      outcome: "already-taken",
    });
    expect(getTakenDoseIds(profile.id, today(profile.id)).size).toBe(1);
    expect(revalidate).toHaveBeenCalledWith("/");
    expect(revalidate).toHaveBeenCalledWith("/nutrition");
    expect(revalidate).toHaveBeenCalledWith("/medications");
  });

  it("a bogus dose id is a safe no-op that answers stale-dose", async () => {
    const { profile } = seedActor();
    expect(await markAttentionDose(fd({ dose_id: 999999 }))).toEqual({
      ok: true,
      outcome: "stale-dose",
    });
    expect(getTakenDoseIds(profile.id, today(profile.id)).size).toBe(0);
  });

  it("a paused item's dose refuses with `inactive` and logs nothing (#2106)", async () => {
    const { profile } = seedActor();
    const doseId = seedDose(profile.id);
    db.prepare("UPDATE intake_items SET active = 0 WHERE profile_id = ?").run(
      profile.id
    );
    expect(await markAttentionDose(fd({ dose_id: doseId }))).toEqual({
      ok: true,
      outcome: "inactive",
    });
    expect(getTakenDoseIds(profile.id, today(profile.id)).size).toBe(0);
  });

  it("a dose retired by a schedule edit refuses with `stale-dose` (#2106)", async () => {
    const { profile } = seedActor();
    const doseId = seedDose(profile.id);
    db.prepare("UPDATE intake_item_doses SET retired = 1 WHERE id = ?").run(
      doseId
    );
    expect(await markAttentionDose(fd({ dose_id: doseId }))).toEqual({
      ok: true,
      outcome: "stale-dose",
    });
    expect(getTakenDoseIds(profile.id, today(profile.id)).size).toBe(0);
  });
});
