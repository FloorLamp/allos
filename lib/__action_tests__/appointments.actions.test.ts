// SERVER-ACTION TIER — the appointment → encounter lifecycle (issue #288). These
// actions now live on the merged Visits page (app/(app)/encounters/appointment-
// actions.ts). Exercises the "Log this visit" close-the-loop (a completed
// appointment spawns a linked, prefilled encounter) and the row-ops side-state
// (deleting either side nulls/preserves the appointments.encounter_id link),
// against a real temp SQLite handle so the FK + scoping are genuinely exercised.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import {
  createAppointment,
  completeAppointment,
  logVisitFromAppointment,
} from "@/app/(app)/encounters/appointment-actions";
import { deleteEncounter } from "@/app/(app)/encounters/actions";
import { getAppointments, getEncounters } from "@/lib/queries";
import { seedActor, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

beforeEach(() => revalidate.mockClear());

// Book a scheduled appointment via the real action and return its id.
async function book(
  fields: Record<string, string>,
  profileId: number
): Promise<number> {
  await createAppointment(fd(fields));
  const rows = getAppointments(profileId);
  return rows[rows.length - 1].id;
}

describe("logVisitFromAppointment (#288)", () => {
  it("creates a linked, prefilled encounter and completes the appointment", async () => {
    const { profile } = seedActor();
    const id = await book(
      {
        title: "Annual physical",
        scheduled_at: "2026-03-10",
        provider: "Dr. Rivera",
        kind: "physical",
        notes: "fasting labs",
      },
      profile.id
    );

    await logVisitFromAppointment(fd({ id }));

    // The appointment is completed and now links its resulting visit.
    const appt = getAppointments(profile.id).find((a) => a.id === id)!;
    expect(appt.status).toBe("completed");
    expect(appt.encounter_id).not.toBeNull();

    // The encounter is prefilled from the appointment: same day, provider, the
    // kind mapped to a human type, the title as the reason, notes carried over.
    const enc = getEncounters(profile.id).find(
      (e) => e.id === appt.encounter_id
    )!;
    expect(enc.date).toBe("2026-03-10");
    expect(enc.provider_name).toBe("Dr. Rivera");
    expect(enc.type).toBe("Physical / check-up");
    expect(enc.reason).toBe("Annual physical");
    expect(enc.notes).toBe("fasting labs");
    // A manual visit — no import provenance, so a document delete never touches it.
    expect(enc.source).toBeNull();
    expect(enc.document_id).toBeNull();
    expect(revalidate).toHaveBeenCalledWith("/encounters");
  });

  it("is idempotent — a second call adds no duplicate visit", async () => {
    const { profile } = seedActor();
    const id = await book(
      { title: "Dental cleaning", scheduled_at: "2026-04-01", kind: "dental" },
      profile.id
    );

    await logVisitFromAppointment(fd({ id }));
    const firstLink = getAppointments(profile.id).find(
      (a) => a.id === id
    )!.encounter_id;
    await logVisitFromAppointment(fd({ id }));

    // Still exactly one visit, and the link is unchanged.
    expect(getEncounters(profile.id)).toHaveLength(1);
    expect(
      getAppointments(profile.id).find((a) => a.id === id)!.encounter_id
    ).toBe(firstLink);
  });

  it("cannot log a visit for another profile's appointment (scoped)", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("ApptB", login.id);
    actAs(login, profileB);
    const bId = await book(
      { title: "B visit", scheduled_at: "2026-05-05" },
      profileB.id
    );

    actAs(login, profileA);
    await logVisitFromAppointment(fd({ id: bId }));

    // B's appointment is untouched and no visit was created anywhere.
    expect(getAppointments(profileB.id).find((a) => a.id === bId)!.status).toBe(
      "scheduled"
    );
    expect(getEncounters(profileA.id)).toHaveLength(0);
    expect(getEncounters(profileB.id)).toHaveLength(0);
  });
});

describe("row-ops: appointment ↔ encounter link side-state (#288)", () => {
  it("deleting the linked encounter nulls the appointment link but keeps the appointment", async () => {
    const { profile } = seedActor();
    const id = await book(
      { title: "Eye exam", scheduled_at: "2026-06-01", kind: "vision" },
      profile.id
    );
    await logVisitFromAppointment(fd({ id }));
    const encId = getAppointments(profile.id).find(
      (a) => a.id === id
    )!.encounter_id!;

    await deleteEncounter(fd({ id: encId }));

    // The visit is gone; the appointment survives, completed, just unlinked.
    expect(getEncounters(profile.id)).toHaveLength(0);
    const appt = getAppointments(profile.id).find((a) => a.id === id)!;
    expect(appt.status).toBe("completed");
    expect(appt.encounter_id).toBeNull();
  });

  it("a plain complete (no log) leaves the link null", async () => {
    const { profile } = seedActor();
    const id = await book(
      { title: "Check-up", scheduled_at: "2026-07-01" },
      profile.id
    );
    await completeAppointment(fd({ id }));
    const appt = getAppointments(profile.id).find((a) => a.id === id)!;
    expect(appt.status).toBe("completed");
    expect(appt.encounter_id).toBeNull();
  });
});
