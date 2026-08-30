// SERVER-ACTION TIER — the two kinds the record's ⋯ draws only on the acting profile.
//
// #3958 phase 2 put symptoms (Logs) and cycle markers (Life) on the record, and both
// are ⋯ kinds. But `editSymptom`, `saveCycleAction` and `deleteCycleAction` resolve
// their subject from the SESSION (`requireWriteAccess`), unlike the five phase-1
// corrections that take the row's `profile_id` through `gateItemProfile` (#4067). So a
// ⋯ drawn on another member's symptom or cycle row would have posted a write that
// lands somewhere other than the row it came from, and the renderer gates those two
// kinds to the acting profile's own rows until the cores take a subject.
//
// THAT GATE IS A CLAIM ABOUT THE RENDERER, AND THIS FILE IS THE OTHER HALF. #4009
// states the standard: "a test proves a forged submit for a profile this login cannot
// write is refused — not merely that the button is absent." A missing ⋯ is satisfied
// by a page that draws nothing AND by a page whose action would happily have written;
// only a post that reaches the action tells those apart. Each case below builds the
// FormData the gated ⋯ would have carried and calls the real exported action.
//
// WHAT IS BEING PROVEN IS CONTAINMENT, WHICH IS NOT THE SAME AS THE CAPABILITY. The
// capability #3958's multiprofile clause asks for — a correction on another member's
// row landing on THAT member — is not here and is not implemented; moving all three
// actions onto `gateItemProfile` is the follow-up. What must hold in the meantime is
// narrower and is the security-relevant half: a forged submit must never reach another
// member's stored row. The two kinds satisfy it for different reasons, so they are
// asserted separately rather than forced into one table.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  saveCycleAction,
  deleteCycleAction,
} from "@/app/(app)/medical/cycles/actions";
import { editSymptom } from "@/app/(app)/symptom-actions";
import { createCycleRow } from "@/lib/cycle-store";
import { setSymptomSeverityCore } from "@/lib/symptom-log-write";
import { createLogin, createProfile, actAs, fd } from "./harness";

const DAY = "2026-06-11";

// The two cycle actions differ only in the post they take and the refusal they return,
// which is exactly the case for a table. Both scope their row lookup by the SESSION's
// profile (`getCycleRow(profile.id, id)` / `deleteCycleRow(profile.id, id)`), so a
// forged id belonging to another member simply is not found.
const CYCLE_ACTIONS = [
  {
    name: "saveCycleAction",
    post: (id: number) =>
      fd({ id, period_start: "2026-06-20", period_end: "2026-06-24" }),
    run: saveCycleAction,
    refused: (result: unknown) =>
      expect(result).toMatchObject({ ok: false, error: expect.any(String) }),
  },
  {
    name: "deleteCycleAction",
    post: (id: number) => fd({ id }),
    run: deleteCycleAction,
    refused: (result: unknown) =>
      expect(result).toMatchObject({ undoId: null, error: expect.any(String) }),
  },
] as const;

describe("the record's acting-profile-only kinds contain a forged submit (#3958)", () => {
  describe.each(CYCLE_ACTIONS)("$name", (action) => {
    it("refuses a cycle row forged for another WRITE-GRANTED member", async () => {
      // BOTH profiles are granted to this login, and that is the point: the refusal
      // must come from the action scoping its row lookup to the acting profile, not
      // from the login lacking access. A stranger profile would have been refused by
      // `requireWriteAccess` and proven nothing about these three actions.
      const login = createLogin();
      const acting = createProfile(`acting ${action.name}`, login.id);
      const member = createProfile(`member ${action.name}`, login.id);
      actAs(login, acting);

      const rowId = createCycleRow(member.id, DAY, null, null, "member note");
      action.refused(await action.run(action.post(rowId)));

      // THE STORE, not the return value: an action can report a refusal and still
      // have written. The member's row is unchanged and still theirs.
      const row = db
        .prepare(
          "SELECT profile_id, period_start, period_end FROM cycles WHERE id = ?"
        )
        .get(rowId) as
        | {
            profile_id: number;
            period_start: string;
            period_end: string | null;
          }
        | undefined;
      expect(row).toMatchObject({
        profile_id: member.id,
        period_start: DAY,
        period_end: null,
      });
    });
  });

  // SYMPTOMS ARE CONTAINED BY A DIFFERENT MECHANISM, and it is worth naming because
  // the refusal above does not describe it. `editSymptom` writes through
  // `setSymptomSeverityCore(profile.id, symptom, …)`, which is keyed on (profile,
  // symptom, date) rather than on a posted row id — so a forged post naming another
  // member's symptom row cannot address it at all. The write is not refused; it lands
  // on the ACTING profile's own record for that symptom and day. That is precisely the
  // gap the renderer gate exists to keep off the screen, and the containment property
  // is that the member's row does not move.
  it("cannot reach another member's symptom row, and lands on the acting profile instead", async () => {
    const login = createLogin();
    const acting = createProfile("acting symptom", login.id);
    const member = createProfile("member symptom", login.id);
    actAs(login, acting);

    setSymptomSeverityCore(
      member.id,
      "headache",
      2,
      DAY,
      "page",
      "member note"
    );

    // THE POST CARRIES A `profile_id`, deliberately — the field the five phase-1
    // corrections gate on. A forgery would spell the subject the way the rest of the
    // record does, and this action has to ignore it rather than honour it.
    const result = await editSymptom(
      fd({
        symptom: "headache",
        severity: 4,
        date: DAY,
        note: "forged",
        profile_id: member.id,
      })
    );
    expect(result).toMatchObject({ ok: true });

    const severityFor = (profileId: number) =>
      (db
        .prepare(
          "SELECT severity, note FROM symptom_logs WHERE profile_id = ? AND date = ? AND symptom = 'headache'"
        )
        .get(profileId, DAY) as
        { severity: number; note: string | null } | undefined) ?? null;

    // The member's row is untouched — severity and note both as seeded.
    expect(severityFor(member.id)).toMatchObject({
      severity: 2,
      note: "member note",
    });
    // And the write went to the acting profile, which is what makes the assertion
    // above a containment result rather than an action that silently did nothing.
    expect(severityFor(acting.id)).toMatchObject({ severity: 4 });
  });
});
