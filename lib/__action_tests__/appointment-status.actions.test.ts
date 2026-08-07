// SERVER-ACTION TIER — the appointment status CAS core and its typed outcomes
// (#2134). The three one-tap actions (complete / cancel / reopen) used to be a
// bare `SET status = ?` that could not refuse; they now ride
// lib/appointment-status.ts's compare-and-swap, matching the import path's
// scheduled-only guard. Exercised through the real Server Actions so the auth
// boundary, the outcome mapping, and the revalidation are all on the hook —
// including the palette's dispatch shape (CommandPalette calls the SAME
// completeAppointment and renders res.ok / res.outcome).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  createAppointment,
  completeAppointment,
  cancelAppointment,
  reopenAppointment,
} from "@/app/(app)/encounters/appointment-actions";
import { getAppointments } from "@/lib/queries";
import { seedActor, createProfile, actAs, fd } from "./harness";

// Book a scheduled appointment via the real action and return its id.
async function book(profileId: number, title: string): Promise<number> {
  await createAppointment(fd({ title, date: "2026-06-01" }));
  const rows = getAppointments(profileId);
  return rows[rows.length - 1].id;
}

function statusOf(profileId: number, id: number): string {
  return getAppointments(profileId).find((a) => a.id === id)!.status;
}

describe("appointment status one-taps ride the CAS core (#2134)", () => {
  it("completes a scheduled appointment, and a second tap answers 'already'", async () => {
    const { profile } = seedActor();
    const id = await book(profile.id, "Annual physical");

    expect(await completeAppointment(fd({ id }))).toEqual({
      ok: true,
      outcome: "done",
    });
    expect(statusOf(profile.id, id)).toBe("completed");

    // The double-tap: the target state already stands — an honest idempotent
    // answer, not a rewrite and not an unconditional success.
    expect(await completeAppointment(fd({ id }))).toEqual({
      ok: true,
      outcome: "already",
    });
    expect(statusOf(profile.id, id)).toBe("completed");
  });

  it("refuses to complete a cancelled appointment (cross-state conflict)", async () => {
    const { profile } = seedActor();
    const id = await book(profile.id, "Dermatology follow-up");
    await cancelAppointment(fd({ id }));

    const res = await completeAppointment(fd({ id }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("cancelled");
    // The refusal wrote nothing: the cancellation stands.
    expect(statusOf(profile.id, id)).toBe("cancelled");
  });

  it("refuses to cancel a completed appointment", async () => {
    const { profile } = seedActor();
    const id = await book(profile.id, "Eye exam");
    await completeAppointment(fd({ id }));

    const res = await cancelAppointment(fd({ id }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("completed");
    expect(statusOf(profile.id, id)).toBe("completed");
  });

  it("reopen on a still-scheduled row answers 'already' and writes nothing", async () => {
    const { profile } = seedActor();
    const id = await book(profile.id, "Dental cleaning");

    expect(await reopenAppointment(fd({ id }))).toEqual({
      ok: true,
      outcome: "already",
    });
    expect(statusOf(profile.id, id)).toBe("scheduled");
  });

  it("reopens a cancelled appointment", async () => {
    const { profile } = seedActor();
    const id = await book(profile.id, "Physio intake");
    await cancelAppointment(fd({ id }));

    expect(await reopenAppointment(fd({ id }))).toEqual({
      ok: true,
      outcome: "done",
    });
    expect(statusOf(profile.id, id)).toBe("scheduled");
  });

  it("answers not-found for a forged id and for another profile's row (scoped)", async () => {
    const { login, profile: profileA } = seedActor();
    expect(await completeAppointment(fd({ id: 999999 }))).toEqual({
      ok: false,
      error: "Couldn't find that appointment.",
    });

    const profileB = createProfile("ApptStatusB", login.id);
    actAs(login, profileB);
    const bId = await book(profileB.id, "B-only visit");

    actAs(login, profileA);
    expect(await completeAppointment(fd({ id: bId }))).toEqual({
      ok: false,
      error: "Couldn't find that appointment.",
    });
    expect(statusOf(profileB.id, bId)).toBe("scheduled");
  });

  it("a stale complete never clobbers the import path's encounter link", async () => {
    // The import auto-complete CASes scheduled→completed AND records the
    // encounter back-link; a racing one-tap that lost must answer 'already'
    // and leave the link intact.
    const { profile } = seedActor();
    const id = await book(profile.id, "Imported visit");
    const encId = Number(
      db
        .prepare(
          `INSERT INTO encounters (profile_id, date, type) VALUES (?, '2026-06-01', 'Office visit')`
        )
        .run(profile.id).lastInsertRowid
    );
    db.prepare(
      `UPDATE appointments SET status = 'completed', encounter_id = ?
        WHERE id = ? AND profile_id = ?`
    ).run(encId, id, profile.id);

    expect(await completeAppointment(fd({ id }))).toEqual({
      ok: true,
      outcome: "already",
    });
    const row = getAppointments(profile.id).find((a) => a.id === id)!;
    expect(row.status).toBe("completed");
    expect(row.encounter_id).toBe(encId);
  });
});
