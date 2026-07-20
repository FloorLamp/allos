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
  completeCarePlanItemFromAppointment,
} from "@/app/(app)/encounters/appointment-actions";
import { deleteEncounter } from "@/app/(app)/encounters/actions";
import { addCarePlanItem } from "@/app/(app)/care-plan/actions";
import {
  getAppointments,
  getEncounters,
  getCarePlanItems,
  collectUpcoming,
} from "@/lib/queries";
import { matchCarePlanItemsForAppointment } from "@/lib/care-plan-appointment";
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
    expect(revalidate).toHaveBeenCalledWith("/records");
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

describe("completeCarePlanItemFromAppointment — close the care-plan loop (#658)", () => {
  it("a completed colonoscopy appointment satisfies the matching open care-plan item", async () => {
    const { profile } = seedActor();
    // An imported "colonoscopy in March" care-plan item, still open.
    await addCarePlanItem(
      fd({
        description: "Colonoscopy screening",
        planned_date: "2026-03-20",
        status: "planned",
      })
    );
    const item = getCarePlanItems(profile.id).find(
      (c) => c.description === "Colonoscopy screening"
    )!;
    expect(item.status).toBe("planned");

    // Book + complete the matching colonoscopy appointment.
    const apptId = await book(
      { title: "Colonoscopy", scheduled_at: "2026-03-15", kind: "screening" },
      profile.id
    );
    await completeAppointment(fd({ id: apptId }));
    const appt = getAppointments(profile.id).find((a) => a.id === apptId)!;

    // The pure matcher the UI drives finds it (kind/description/date-window).
    const matches = matchCarePlanItemsForAppointment(
      {
        kind: appt.kind,
        title: appt.title,
        notes: appt.notes,
        scheduledAt: appt.scheduled_at,
      },
      getCarePlanItems(profile.id).map((c) => ({
        id: c.id,
        description: c.description,
        code: c.code,
        planned_date: c.planned_date,
        status: c.status,
      }))
    );
    expect(matches.map((m) => m.id)).toContain(item.id);

    // Accept the offer → the item closes and drops off Upcoming.
    await completeCarePlanItemFromAppointment(fd({ id: item.id }));
    expect(
      getCarePlanItems(profile.id).find((c) => c.id === item.id)!.status
    ).toBe("completed");
    const upcoming = collectUpcoming(profile.id, "2026-03-16");
    expect(upcoming.some((u) => u.key === `careplan:${item.id}`)).toBe(false);
  });

  it("is profile-scoped — can't close another profile's care-plan item", async () => {
    const { login, profile: profileA } = seedActor();
    const profileB = createProfile("CareB", login.id);
    actAs(login, profileB);
    await addCarePlanItem(
      fd({
        description: "B item",
        planned_date: "2026-03-20",
        status: "planned",
      })
    );
    const bItem = getCarePlanItems(profileB.id)[0];

    actAs(login, profileA);
    await completeCarePlanItemFromAppointment(fd({ id: bItem.id }));

    // B's item is untouched (the WHERE profile_id guard no-ops the cross-profile id).
    expect(
      getCarePlanItems(profileB.id).find((c) => c.id === bItem.id)!.status
    ).toBe("planned");
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
