import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";
import { practiceIdentity } from "@/lib/practice";

// Per-practice weekly rhythm on the protocol/practice cards (#2188): a practice
// with an inferred weekly rhythm shows a calm "usually a session day" note on a
// predicted day with nothing logged yet, and a young practice (below the
// habitual-day gate) shows NOTHING anywhere — the #558 honesty rule, pinned here
// end-to-end. Both subjects are seeded straight into the worker DB (#868
// spec-owned fixtures): inference reads practice_logs, and the write path's
// forged-date window rightly refuses dates this old.
test("practice cards show the rhythm note on a predicted day and nothing for a young practice (#2188)", async ({
  page,
}) => {
  const suffix = frozenNow().getTime();
  const rhythmName = `E2E Rhythm ${suffix}`;
  const youngName = `E2E Young ${suffix}`;
  const today = frozenNow().toISOString().slice(0, 10);
  const shift = (days: number) => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  let rhythmProtocolId = 0;
  let youngProtocolId = 0;
  const targetIds: number[] = [];
  try {
    const target = db.prepare(
      `INSERT INTO frequency_targets
         (profile_id, scope_kind, scope_value, scope_identity, per_week)
       VALUES (1, 'practice', ?, ?, 3)`
    );
    const rhythmTargetId = Number(
      target.run(rhythmName, practiceIdentity(rhythmName)).lastInsertRowid
    );
    const youngTargetId = Number(
      target.run(youngName, practiceIdentity(youngName)).lastInsertRowid
    );
    targetIds.push(rhythmTargetId, youngTargetId);
    const log = db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, time)
       VALUES (1, ?, ?, ?)`
    );
    // Four sessions on TODAY's weekday across the past four weeks — at the
    // habitual-day gate (max(2, ceil(8 × 0.4)) = 4 distinct dates), so today is
    // a predicted day. Nothing logged today, so the zero-count line renders.
    for (const back of [7, 14, 21, 28])
      log.run(rhythmName, shift(-back), "18:30");
    // The young practice has ONE session yesterday: below the gate → no pattern.
    log.run(youngName, shift(-1), null);
    const protocol = db.prepare(
      `INSERT INTO protocols (profile_id, name, start_date, frequency_target_id)
       VALUES (1, ?, ?, ?)`
    );
    rhythmProtocolId = Number(
      protocol.run(`${rhythmName} protocol`, shift(-30), rhythmTargetId)
        .lastInsertRowid
    );
    youngProtocolId = Number(
      protocol.run(`${youngName} protocol`, shift(-30), youngTargetId)
        .lastInsertRowid
    );

    // The protocol detail card: rhythm-aware copy beside the zero-count line.
    await page.goto(`/protocols/${rhythmProtocolId}`);
    const card = page.getByRole("main").getByTestId("protocol-practice-card");
    const todayLine = card.getByTestId("practice-today-count");
    await expect(todayLine).toContainText("No sessions yet");
    await expect(card.getByTestId("practice-rhythm-note")).toContainText(
      "usually a session day"
    );

    // The young practice renders NOTHING rhythm-shaped (#558): same zero-count
    // line, no note.
    await page.goto(`/protocols/${youngProtocolId}`);
    const youngCard = page
      .getByRole("main")
      .getByTestId("protocol-practice-card");
    await expect(youngCard.getByTestId("practice-today-count")).toContainText(
      "No sessions yet"
    );
    await expect(youngCard.getByTestId("practice-rhythm-note")).toHaveCount(0);

    // The wellness PracticeCard shares the same control and the same decision.
    await page.goto("/wellness");
    const main = page.getByRole("main");
    const wellnessRhythm = main
      .getByTestId("wellness-practice-card")
      .filter({ hasText: rhythmName });
    await expect(
      wellnessRhythm.getByTestId("practice-rhythm-note")
    ).toContainText("usually a session day");
    const wellnessYoung = main
      .getByTestId("wellness-practice-card")
      .filter({ hasText: youngName });
    await expect(wellnessYoung.getByTestId("practice-today-count")).toHaveText(
      "No sessions yet"
    );
  } finally {
    if (rhythmProtocolId)
      db.prepare("DELETE FROM protocols WHERE id = ?").run(rhythmProtocolId);
    if (youngProtocolId)
      db.prepare("DELETE FROM protocols WHERE id = ?").run(youngProtocolId);
    db.prepare("DELETE FROM practice_logs WHERE practice IN (?, ?)").run(
      rhythmName,
      youngName
    );
    for (const id of targetIds)
      db.prepare("DELETE FROM frequency_targets WHERE id = ?").run(id);
    db.close();
  }
});
