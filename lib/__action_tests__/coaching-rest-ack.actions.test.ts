// SERVER-ACTION TIER — the coaching rest card's dismissal controls (#1148/#1150).
//
// acknowledgeRest records a per-day "Training anyway" acknowledgment that is DISTINCT
// from the #39 snooze store: it writes the profile_settings marker, NOT an
// upcoming_dismissals row, and it does not silence tomorrow's re-evaluation. snoozeCoaching
// (renamed "Not today" → "Snooze") still snoozes the shown coaching rec. These assert the
// two stores stay separate and that the ack is scoped to profile + today.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { acknowledgeRest, snoozeCoaching } from "@/app/(app)/actions";
import { getRestAck } from "@/lib/queries";
import { getFindingSuppressions } from "@/lib/queries";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { seedActor, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);
beforeEach(() => revalidate.mockClear());

// The persisted acknowledgment marker row for a profile, or undefined.
function ackMarker(profileId: number): string | undefined {
  return (
    db
      .prepare(
        "SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'coaching_rest_ack'"
      )
      .get(profileId) as { value?: string } | undefined
  )?.value;
}

describe("acknowledgeRest (#1150)", () => {
  it("records a today acknowledgment scoped to the acting profile", async () => {
    const { profile } = seedActor();
    await acknowledgeRest(fd({ reason_ids: "rest-sleep,rest-rhr" }));

    const ack = getRestAck(profile.id, today(profile.id));
    expect(ack).not.toBeNull();
    expect(ack!.date).toBe(today(profile.id));
    expect(ack!.reasonIds).toEqual(["rest-sleep", "rest-rhr"]);
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("does NOT write the #39 snooze store (an ack is not a dismissal)", async () => {
    const { profile } = seedActor();
    await acknowledgeRest(fd({ reason_ids: "rest-sleep" }));

    // No suppression row landed — the ack lives only in profile_settings.
    const suppressions = getFindingSuppressions(profile.id);
    expect(suppressions.size).toBe(0);
    const rows = db
      .prepare(
        "SELECT COUNT(*) AS n FROM upcoming_dismissals WHERE profile_id = ?"
      )
      .get(profile.id) as { n: number };
    expect(rows.n).toBe(0);
    // The ack marker IS present.
    expect(ackMarker(profile.id)).toBeTruthy();
  });

  it("does not silence tomorrow — getRestAck ignores a stale (past-date) marker", async () => {
    const { profile } = seedActor();
    await acknowledgeRest(fd({ reason_ids: "rest-sleep" }));

    // Read as of tomorrow: the today-only marker no longer applies.
    const tomorrow = shiftDateStr(today(profile.id), 1);
    expect(getRestAck(profile.id, tomorrow)).toBeNull();
    // But it still applies today.
    expect(getRestAck(profile.id, today(profile.id))).not.toBeNull();
  });

  it("drops unknown reason ids (a tampered form can't inject arbitrary signals)", async () => {
    const { profile } = seedActor();
    await acknowledgeRest(fd({ reason_ids: "rest-sleep,evil,rest-load" }));
    const ack = getRestAck(profile.id, today(profile.id));
    expect(ack!.reasonIds).toEqual(["rest-sleep", "rest-load"]);
  });

  it("is profile-scoped — an ack on one profile is invisible to another", async () => {
    const { login, profile: a } = seedActor();
    await acknowledgeRest(fd({ reason_ids: "rest-sleep" }));
    const b = createProfile("Second", login.id);
    actAs(login, b);

    expect(getRestAck(a.id, today(a.id))).not.toBeNull();
    expect(getRestAck(b.id, today(b.id))).toBeNull();
  });
});

describe("snoozeCoaching (renamed 'Snooze', #1150) still snoozes", () => {
  it("writes a snooze row for the shown coaching rec through the findings bus", async () => {
    const { profile } = seedActor();
    await snoozeCoaching(fd({ dedupe_key: "coaching:rest-sleep" }));

    const map = getFindingSuppressions(profile.id);
    const rec = map.get("coaching:rest-sleep");
    expect(rec).toBeTruthy();
    // Snoozed until tomorrow — and it did NOT write an ack marker.
    expect(ackMarker(profile.id)).toBeUndefined();
    expect(revalidate).toHaveBeenCalledWith("/");
  });

  it("ignores a non-coaching key (namespace guard)", async () => {
    const { profile } = seedActor();
    await snoozeCoaching(fd({ dedupe_key: "dose:5" }));
    expect(getFindingSuppressions(profile.id).size).toBe(0);
  });
});
