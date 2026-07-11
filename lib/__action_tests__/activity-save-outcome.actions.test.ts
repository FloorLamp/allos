// SERVER-ACTION TIER — saveActivity answers with a typed outcome (issue #332) so
// the auto-saving form can never confirm "Saved ✓" for a save that didn't persist.
// Pins the two silent-failure paths: a foreign/stale id (ownership check) and an
// invalid title/date — each must return { ok: false } and write NO row.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { saveActivity } from "@/app/(app)/journal/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

const cardio = JSON.stringify([
  { name: "Running", type: "cardio", distance: null, duration_min: 30 },
]);

function activityCount(profileId: number): number {
  return (
    db
      .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
      .get(profileId) as { n: number }
  ).n;
}

describe("saveActivity typed outcome (issue #332)", () => {
  it("returns { ok: true, id } and writes the row on a valid create", async () => {
    const login = createLogin();
    const profile = createProfile("owner", login.id);
    actAs(login, profile);

    const res = await saveActivity(
      fd({
        type: "cardio",
        title: "Morning run",
        date: "2026-07-01",
        components: cardio,
        sets: "[]",
      })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(typeof res.id).toBe("number");
    expect(activityCount(profile.id)).toBe(1);
  });

  it("returns { ok: false, reason: 'not-owned' } for a foreign id and writes nothing", async () => {
    // Another profile owns the target activity.
    const otherLogin = createLogin();
    const otherProfile = createProfile("someone-else", otherLogin.id);
    actAs(otherLogin, otherProfile);
    const created = await saveActivity(
      fd({
        type: "cardio",
        title: "Their run",
        date: "2026-07-02",
        components: cardio,
        sets: "[]",
      })
    );
    if (!created.ok) throw new Error("setup save failed");
    const foreignId = created.id;

    // The active profile switches; a stale auto-save carries the other profile's id.
    const login = createLogin();
    const profile = createProfile("active", login.id);
    actAs(login, profile);

    const before = activityCount(profile.id);
    const res = await saveActivity(
      fd({
        id: foreignId,
        type: "cardio",
        title: "Edited title",
        date: "2026-07-02",
        components: cardio,
        sets: "[]",
      })
    );
    expect(res).toEqual({ ok: false, reason: "not-owned" });
    // No row written for the active profile...
    expect(activityCount(profile.id)).toBe(before);
    // ...and the foreign row is untouched (its title did not change).
    const foreign = db
      .prepare("SELECT title FROM activities WHERE id = ?")
      .get(foreignId) as { title: string };
    expect(foreign.title).toBe("Their run");
  });

  it("returns { ok: false, reason: 'invalid' } for a blank title and writes nothing", async () => {
    const login = createLogin();
    const profile = createProfile("validator", login.id);
    actAs(login, profile);

    const res = await saveActivity(
      fd({
        type: "cardio",
        title: "   ",
        date: "2026-07-03",
        components: cardio,
        sets: "[]",
      })
    );
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(activityCount(profile.id)).toBe(0);
  });

  it("returns { ok: false, reason: 'invalid' } for a non-ISO date", async () => {
    const login = createLogin();
    const profile = createProfile("validator2", login.id);
    actAs(login, profile);

    const res = await saveActivity(
      fd({
        type: "cardio",
        title: "Run",
        date: "Friday",
        components: cardio,
        sets: "[]",
      })
    );
    expect(res).toEqual({ ok: false, reason: "invalid" });
    expect(activityCount(profile.id)).toBe(0);
  });
});
