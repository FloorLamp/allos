// SERVER-ACTION TIER — the protocol end/resume lifecycle (#2135).
//
// `protocols.end_date` is a three-state machine (ongoing / resumable / expired) whose
// states are named once in the pure `protocolReopenEligibility`. Until #2135 the two
// one-tap transitions over it read the row with `getProtocol` OUTSIDE the writeTx they
// wrote in and swapped with a WHERE that could not refuse; this pins the core's typed
// refusals through the actions that render them, plus the invariant the pairing exists
// for — the row's `end_date` and the profile's active SITUATION set move together, in
// one transaction, or not at all.
//
// SYNTHETIC ONLY: invented protocol names and fictional dates. No PHI.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { endProtocol, resumeProtocol } from "@/app/(app)/protocols/actions";
import { getActiveSituations } from "@/lib/settings";
import { PROTOCOL_REOPEN_WINDOW_DAYS } from "@/lib/protocol-reopen";
import { createLogin, createProfile, actAs, fd } from "./harness";

const SITUATION = "Fictional block";

function seed(): { profileId: number } {
  const admin = createLogin({ role: "admin" });
  const profile = createProfile("Test Patient");
  actAs(admin, profile);
  return { profileId: profile.id };
}

function newProtocol(
  profileId: number,
  endDate: string | null,
  situation: string | null = SITUATION
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO protocols
           (profile_id, name, start_date, end_date, situation, outcome_keys)
         VALUES (?, 'Fictional protocol', '2026-01-01', ?, ?, '[]')`
      )
      .run(profileId, endDate, situation).lastInsertRowid
  );
}

function endDateOf(id: number): string | null {
  return (
    db.prepare("SELECT end_date FROM protocols WHERE id = ?").get(id) as {
      end_date: string | null;
    }
  ).end_date;
}

describe("endProtocol (#2135)", () => {
  it("ends an ongoing protocol and deactivates the situation it activated", async () => {
    const { profileId } = seed();
    const id = newProtocol(profileId, null);
    db.prepare(
      `INSERT INTO situations (profile_id, name, active) VALUES (?, ?, 1)`
    ).run(profileId, SITUATION);

    expect(await endProtocol(fd({ id: String(id) }))).toEqual({ ok: true });
    expect(endDateOf(id)).toBe(today(profileId));
    // The pairing the one transaction exists for: a protocol reading "ended" while
    // its situation stayed active would keep firing situational supplements.
    expect(getActiveSituations(profileId)).not.toContain(SITUATION);
  });

  it("refuses an already-ended protocol instead of moving its end date", async () => {
    const { profileId } = seed();
    const id = newProtocol(profileId, "2026-02-01");

    const result = await endProtocol(fd({ id: String(id) }));
    expect(result).toEqual({
      ok: false,
      error: "That protocol has already ended.",
    });
    // The comparison window the results are computed over is untouched.
    expect(endDateOf(id)).toBe("2026-02-01");
  });

  it("refuses a protocol that belongs to another profile", async () => {
    const { profileId } = seed();
    const stranger = createProfile("Other Patient");
    const id = newProtocol(stranger.id, null);

    expect(await endProtocol(fd({ id: String(id) }))).toEqual({
      ok: false,
      error: "Couldn't find that protocol.",
    });
    expect(endDateOf(id)).toBeNull();
    expect(profileId).not.toBe(stranger.id);
  });

  it("leaves a SIBLING protocol's situation alone", async () => {
    // The row-side-state rule: ending one protocol inverts the activation IT caused,
    // never one another ongoing protocol still needs.
    const { profileId } = seed();
    const ending = newProtocol(profileId, null);
    newProtocol(profileId, null);
    db.prepare(
      `INSERT INTO situations (profile_id, name, active) VALUES (?, ?, 1)`
    ).run(profileId, SITUATION);

    await endProtocol(fd({ id: String(ending) }));
    expect(getActiveSituations(profileId)).toContain(SITUATION);
  });
});

describe("resumeProtocol (#2135)", () => {
  it("reopens a recently ended protocol and reactivates its situation", async () => {
    const { profileId } = seed();
    const id = newProtocol(profileId, shiftDateStr(today(profileId), -2));

    expect(await resumeProtocol(fd({ id: String(id) }))).toEqual({ ok: true });
    expect(endDateOf(id)).toBeNull();
    expect(getActiveSituations(profileId)).toContain(SITUATION);
  });

  it("refuses a protocol ended past the reopen window, and names the alternative", async () => {
    const { profileId } = seed();
    const id = newProtocol(
      profileId,
      shiftDateStr(today(profileId), -(PROTOCOL_REOPEN_WINDOW_DAYS + 1))
    );

    expect(await resumeProtocol(fd({ id: String(id) }))).toEqual({
      ok: false,
      error:
        "This protocol is outside the resume window. Run it again instead.",
    });
    expect(endDateOf(id)).not.toBeNull();
  });

  it("refuses an already-ongoing protocol", async () => {
    const { profileId } = seed();
    const id = newProtocol(profileId, null);

    expect(await resumeProtocol(fd({ id: String(id) }))).toEqual({
      ok: false,
      error: "This protocol can't be resumed.",
    });
  });

  it("refuses a stored end date that is not a real past day", async () => {
    const { profileId } = seed();
    const id = newProtocol(profileId, shiftDateStr(today(profileId), 3));

    expect(await resumeProtocol(fd({ id: String(id) }))).toEqual({
      ok: false,
      error: "This protocol can't be resumed.",
    });
    expect(endDateOf(id)).not.toBeNull();
  });

  it("refuses a protocol that belongs to another profile", async () => {
    seed();
    const stranger = createProfile("Other Patient");
    const id = newProtocol(stranger.id, shiftDateStr(today(stranger.id), -1));

    expect(await resumeProtocol(fd({ id: String(id) }))).toEqual({
      ok: false,
      error: "Couldn't find that protocol.",
    });
    expect(endDateOf(id)).not.toBeNull();
  });
});

describe("the end/resume machine round-trips", () => {
  it("ends, resumes, and ends again — each transition refusing its own repeat", async () => {
    const { profileId } = seed();
    const id = newProtocol(profileId, null);
    db.prepare(
      `INSERT INTO situations (profile_id, name, active) VALUES (?, ?, 1)`
    ).run(profileId, SITUATION);

    expect(await endProtocol(fd({ id: String(id) }))).toEqual({ ok: true });
    expect(await endProtocol(fd({ id: String(id) }))).toMatchObject({
      ok: false,
    });
    expect(getActiveSituations(profileId)).not.toContain(SITUATION);

    expect(await resumeProtocol(fd({ id: String(id) }))).toEqual({ ok: true });
    expect(await resumeProtocol(fd({ id: String(id) }))).toMatchObject({
      ok: false,
    });
    expect(getActiveSituations(profileId)).toContain(SITUATION);
    expect(endDateOf(id)).toBeNull();

    expect(await endProtocol(fd({ id: String(id) }))).toEqual({ ok: true });
    expect(endDateOf(id)).toBe(today(profileId));
  });
});
