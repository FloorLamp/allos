// DB INTEGRATION TIER — the findings-suppression bus routing for notification-tick
// nudges (issue #227). Proves the KEY plumbing lines up end-to-end against the real
// query layer:
//   - a biomarker-retest finding dismissed by its `biomarker:<name>` key drops out of
//     BOTH collectUpcoming and the "what's due" digest built from it (the retest-line
//     acceptance — the upcoming digest already honors dismissals; this pins it);
//   - dose reminders + escalation are DELIBERATELY NOT bus-gated: a dose dismissed on
//     the Upcoming page still surfaces in the supplement reminder and the escalation
//     candidate gather (collectWindowDoses), matching the safety-tier contract.
// The pure send/skip decisions live in lib/__tests__/{refill,preventive}-nudge.test.ts.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { collectUpcoming } from "@/lib/queries";
import { groupUpcoming } from "@/lib/upcoming";
import { buildUpcomingDigest } from "@/lib/notifications/upcoming-digest";
import { collectWindowDoses } from "@/lib/notifications/supplements";
import { buildSupplementReminder } from "@/lib/notifications/supplements";
import { seedProfile, type SeededProfile } from "./fixtures";

function dismiss(profileId: number, signalKey: string) {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, dismissed_at)
       VALUES (?, ?, datetime('now'))`
  ).run(profileId, signalKey);
}
function clear(profileId: number) {
  db.prepare("DELETE FROM upcoming_dismissals WHERE profile_id = ?").run(
    profileId
  );
}

let p: SeededProfile;
let retestKey: string;

beforeAll(() => {
  p = seedProfile("NSUP");
  // A lab reading ~2 years old → past its retest window, so biomarkerItems surfaces
  // it as `biomarker:ldl cholesterol`. Synthetic value/shape only.
  const oldDate = shiftDateStr(p.todayStr, -730);
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
     VALUES (?, ?, 'lab', 'LDL', '150', 'mg/dL', 'LDL Cholesterol', 150, 'Lipids')`
  ).run(p.profileId, oldDate);
  retestKey = "biomarker:ldl cholesterol";
});

describe("biomarker-retest lines honor the bus (digest acceptance)", () => {
  it("dismissing the retest key drops it from collectUpcoming and the upcoming digest", () => {
    clear(p.profileId);
    const before = collectUpcoming(p.profileId, p.todayStr);
    expect(before.some((i) => i.key === retestKey)).toBe(true);
    const digestBefore = buildUpcomingDigest(
      p.tag,
      groupUpcoming(before, p.todayStr)
    );
    const totalBefore = digestBefore!.total;

    dismiss(p.profileId, retestKey);
    const after = collectUpcoming(p.profileId, p.todayStr);
    expect(after.some((i) => i.key === retestKey)).toBe(false);
    const digestAfter = buildUpcomingDigest(
      p.tag,
      groupUpcoming(after, p.todayStr)
    );
    expect(digestAfter?.total ?? 0).toBe(totalBefore - 1);
    clear(p.profileId);
  });
});

describe("dose reminders + escalation are NOT bus-gated (safety tier)", () => {
  it("a dismissed dose still fires its reminder and stays an escalation candidate", () => {
    clear(p.profileId);
    const date = today(p.profileId);

    // The medication dose is the untaken, due dose (the supplement dose has a taken
    // log in the fixture), so it carries a `dose:<id>` Upcoming key.
    const doseItem = collectUpcoming(p.profileId, p.todayStr).find(
      (i) => i.domain === "dose"
    );
    expect(doseItem).toBeDefined();
    const doseKey = doseItem!.key;

    // Baseline: reminder + escalation gather both see the dose.
    const reminderBefore = buildSupplementReminder(p.profileId, "Morning");
    expect(reminderBefore?.body).toContain("Lisinopril");
    const gatherBefore = collectWindowDoses(p.profileId, "Morning", date);
    expect(gatherBefore.some((e) => e.dose.id === doseItem!.doseId)).toBe(true);

    // Dismiss on the Upcoming page: the bus hides it from the pull surface…
    dismiss(p.profileId, doseKey);
    expect(
      collectUpcoming(p.profileId, p.todayStr).some((i) => i.key === doseKey)
    ).toBe(false);

    // …but the safety-tier reminder + escalation gather are UNAFFECTED.
    const reminderAfter = buildSupplementReminder(p.profileId, "Morning");
    expect(reminderAfter?.body).toContain("Lisinopril");
    const gatherAfter = collectWindowDoses(p.profileId, "Morning", date);
    expect(gatherAfter.some((e) => e.dose.id === doseItem!.doseId)).toBe(true);
    clear(p.profileId);
  });
});
