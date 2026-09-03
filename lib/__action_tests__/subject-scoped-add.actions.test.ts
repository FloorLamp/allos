// SERVER-ACTION TIER — an ADD that follows the surface it was made on (#4693,
// amending #4424 ruling 4 and the 08-29 one-profile-switcher ruling).
//
// `/medications/[id]` is a SUBJECT-SCOPED CONTAINER: it names one profile in its
// identity banner, so the dose history under that banner is unambiguously that
// profile's, and its backfill add now inherits the surface's subject instead of
// resolving one from the session. The whole of that claim is server-side, which is
// why it is asserted here: the button's presence is a claim about the RENDERER, and a
// page that draws nothing satisfies it just as well as a page whose action would
// happily have written the wrong person.
//
// WHAT A WRONG SUBJECT LOOKS LIKE HERE, and it is the reason this file asserts three
// different things about one landed row. `intake_item_logs` carries no `profile_id` —
// the row's subject is its ITEM's owner — so a dose filed against the acting profile
// leaves a row that looks entirely ordinary; the only ways to see whose it is are
// the item it hangs off, the AUDIT row the action stamps, and the ZONE the wall time
// was anchored in. The last is the one a half-conversion breaks: gate the profile but
// keep `getTimezone(acting)` and every dose lands on the wrong DAY, silently, with no
// refusal anywhere. So the fixture gives the two profiles zones a day apart.
//
// Three positions per case, because a one-sided gate is the failure mode: an
// UNGRANTED subject is refused, a READ-ONLY-granted subject is refused, and a
// WRITE-granted subject LANDS. The third is not a formality — a gate that refused
// every cross-profile add would pass the first two and would have shipped the old
// hide with extra machinery.
//
// SYNTHETIC ONLY: invented logins, profiles and medications. No PHI.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { logHistoricalDose } from "@/app/(app)/nutrition/intake-actions";
import { actAs, createLogin, createProfile, fd } from "./harness";

// A caregiver acting as their OWN profile, +13; the subject they are looking after
// lives at −12. One posted wall time therefore resolves to two instants a day apart,
// which is what makes "whose zone was this anchored in" observable in the stored row.
const ACTING_TZ = "Etc/GMT-13"; // UTC+13
const SUBJECT_TZ = "Etc/GMT+12"; // UTC−12

function grant(loginId: number, profileId: number, access: "read" | "write") {
  db.prepare(
    `INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)
       ON CONFLICT(login_id, profile_id) DO UPDATE SET access = excluded.access`
  ).run(loginId, profileId, access);
}

// One PRN medication with an open course, owned by `profileId`. PRN ("may") so the
// backfill is not fighting the scheduled-dose uniqueness rule, and an open-ended
// course so any past day inside the fixture's window is in-course.
function seedMedication(profileId: number): { itemId: number; doseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, obligation, active, source)
         VALUES (?, 'Surface Ibuprofen', 'medication', 'daily', 'may', 1, 'manual')`
      )
      .run(profileId).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '200 mg', '08:00', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on)
     VALUES (?, NULL, NULL)`
  ).run(itemId);
  return { itemId, doseId };
}

// Every dose row hanging off a profile's items, whatever item it belongs to — the
// count a wrong subject would move. Read for BOTH profiles in every case, because
// "landed on the subject" and "did not land on the caregiver" are two claims.
const doseRowsOf = (profileId: number) =>
  db
    .prepare(
      `SELECT l.date AS date, l.occurred_at AS occurredAt
         FROM intake_item_logs l
         JOIN intake_items i ON i.id = l.item_id
        WHERE i.profile_id = ?
        ORDER BY l.id`
    )
    .all(profileId) as { date: string; occurredAt: string | null }[];

const backfillAuditProfiles = (target: string) =>
  db
    .prepare(
      `SELECT active_profile_id AS profileId FROM audit_events
        WHERE action = ? AND target = ?`
    )
    .all(AUDIT_ACTIONS.doseLogBackfill, target) as { profileId: number }[];

// A caregiver, the subject they may write, a subject granted read-only, and one they
// were never granted at all. Both zones are pinned so the day-boundary assertion below
// is about the code and not about the box's clock.
function household(tag: string) {
  const login = createLogin({ role: "member", username: `subjadd_${tag}` });
  const acting = createProfile(`${tag} Caregiver`, login.id);
  const writable = createProfile(`${tag} Ward`, login.id);
  const readOnly = createProfile(`${tag} Read Only`, login.id);
  const ungranted = createProfile(`${tag} Stranger`);
  grant(login.id, acting.id, "write");
  grant(login.id, writable.id, "write");
  grant(login.id, readOnly.id, "read");
  setTimezone(acting.id, ACTING_TZ);
  for (const p of [writable, readOnly, ungranted])
    setTimezone(p.id, SUBJECT_TZ);
  actAs(login, acting);
  return { login, acting, writable, readOnly, ungranted };
}

describe("a backfill add on a subject-scoped container writes that subject (#4693)", () => {
  // THE CAPABILITY. Asserted through the row's own three tells rather than through the
  // action's `{ ok: true }`, which a write onto the caregiver would answer with just as
  // cheerfully.
  it("lands the dose on the page's subject, in the SUBJECT's zone, audited as theirs", async () => {
    const h = household("lands");
    const { itemId, doseId } = seedMedication(h.writable.id);
    const date = shiftDateStr(today(h.writable.id), -3);

    // THE FIXTURE REACHES NOTHING YET. A subject-scoped test that passes because no
    // add happened at all is worse than no test, so both sides start empty and the
    // assertion below is a transition, not a snapshot.
    expect(doseRowsOf(h.writable.id)).toEqual([]);
    expect(doseRowsOf(h.acting.id)).toEqual([]);

    expect(
      await logHistoricalDose(
        fd({
          id: itemId,
          dose_id: doseId,
          date,
          time: "08:30",
          profile_id: h.writable.id,
        })
      )
    ).toEqual({ ok: true });

    // 08:30 on the SUBJECT's day at UTC−12 is 20:30Z the same day. Anchored in the
    // caregiver's UTC+13 instead it would be 19:30Z the day BEFORE — a row filed on
    // the wrong day, with no refusal and nothing on screen to notice.
    expect(doseRowsOf(h.writable.id)).toEqual([
      { date, occurredAt: `${date}T20:30:00Z` },
    ]);
    // The caregiver's own record did not grow one. This is the half a "did it write?"
    // assertion cannot make, and it is the defect class: a row on the wrong person
    // reads exactly like a row on the right one.
    expect(doseRowsOf(h.acting.id)).toEqual([]);
    expect(backfillAuditProfiles(String(itemId))).toEqual([
      { profileId: h.writable.id },
    ]);
  });

  // THE REFUSALS. Same post, same shape, same item — only the grant differs, and the
  // case above is what proves this post would otherwise have written.
  it.each([
    { grantKind: "ungranted", subject: (h: Household) => h.ungranted },
    { grantKind: "read-only", subject: (h: Household) => h.readOnly },
  ])(
    "refuses a forged post for a $grantKind subject and writes nothing",
    async ({ grantKind, subject }) => {
      const h = household(`refuse_${grantKind}`);
      const target = subject(h);
      const { itemId, doseId } = seedMedication(target.id);
      const date = shiftDateStr(today(target.id), -3);

      // requireProfileWriteAccess answers with redirect(), which throws NEXT_REDIRECT
      // before any core runs.
      await expect(
        logHistoricalDose(
          fd({
            id: itemId,
            dose_id: doseId,
            date,
            time: "08:30",
            profile_id: target.id,
          })
        )
      ).rejects.toThrow();
      expect(doseRowsOf(target.id)).toEqual([]);
      expect(doseRowsOf(h.acting.id)).toEqual([]);
      expect(backfillAuditProfiles(String(itemId))).toEqual([]);
    }
  );

  // THE FALLBACK, which is every other mount in the app: a single-subject panel posts
  // no subject, and the gate resolves the acting profile. Without this the change
  // could have moved the default instead of adding an inherited case.
  it("falls back to the acting profile when the surface posts no subject", async () => {
    const h = household("fallback");
    const { itemId, doseId } = seedMedication(h.acting.id);
    const date = shiftDateStr(today(h.acting.id), -3);

    expect(doseRowsOf(h.acting.id)).toEqual([]);
    expect(
      await logHistoricalDose(
        fd({ id: itemId, dose_id: doseId, date, time: "08:30" })
      )
    ).toEqual({ ok: true });

    // The caregiver's own zone this time (UTC+13): 08:30 local is 19:30Z the day
    // before, and the row's stored date is the caregiver's local day.
    expect(doseRowsOf(h.acting.id)).toEqual([
      { date, occurredAt: `${shiftDateStr(date, -1)}T19:30:00Z` },
    ]);
    expect(backfillAuditProfiles(String(itemId))).toEqual([
      { profileId: h.acting.id },
    ]);
  });
});

type Household = ReturnType<typeof household>;
