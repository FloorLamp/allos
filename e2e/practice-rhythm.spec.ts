import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";
import { practiceIdentity } from "@/lib/practice";
import { openDashboardAll } from "./helpers";

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
      `INSERT INTO practice_logs (profile_id, practice, date, start_time)
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

// #4841 item 3 (owner ruling 2026-09-03 14:05 UTC) — THE DASHBOARD PRACTICE ROW IS
// NAMED BY ITS NOUN. The row used to read `Log ${practiceName}` beside an "Open"
// button, leading with the same verb a normal reader would reach for the button to
// do — the shape the ruling generalizes past the frequency-target row #4841 item 2
// already fixed. This reuses #2188's exact rhythm fixture (four sessions on today's
// weekday across the past four weeks, at the habitual-day gate) so
// `practiceUsuallyToday` is true and the row actually renders.
test("the dashboard's practice row is named by the practice, not by its verb (#4841 item 3)", async ({
  page,
}) => {
  const suffix = frozenNow().getTime();
  const practiceName = `E2E Row Noun ${suffix}`;
  const today = frozenNow().toISOString().slice(0, 10);
  const shift = (days: number) => {
    const d = new Date(today + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  let protocolId = 0;
  let targetId = 0;
  try {
    targetId = Number(
      db
        .prepare(
          `INSERT INTO frequency_targets
             (profile_id, scope_kind, scope_value, scope_identity, per_week)
           VALUES (1, 'practice', ?, ?, 3)`
        )
        .run(practiceName, practiceIdentity(practiceName)).lastInsertRowid
    );
    const log = db.prepare(
      `INSERT INTO practice_logs (profile_id, practice, date, start_time)
       VALUES (1, ?, ?, '18:30')`
    );
    for (const back of [7, 14, 21, 28]) log.run(practiceName, shift(-back));
    protocolId = Number(
      db
        .prepare(
          `INSERT INTO protocols (profile_id, name, start_date, frequency_target_id)
           VALUES (1, ?, ?, ?)`
        )
        .run(`${practiceName} protocol`, shift(-30), targetId).lastInsertRowid
    );

    await page.goto("/");
    await openDashboardAll(page);
    // Filtered to THIS fixture's own practice: profile 1 (the shared daily
    // fixture) already carries another practice-target protocol row.
    const row = page
      .locator(
        '[data-testid="dashboard-candidate"][data-candidate-id^="protocol.practice:"]'
      )
      .filter({ hasText: practiceName });
    await expect(row).toBeVisible();
    // THE NOUN, exact — a substring assertion would still pass on the old
    // `Log ${practiceName}` label, since it contains the practice name too. The
    // whole row is one link (no separate control), so the label's OWN span is
    // what has to read the bare noun.
    await expect(row.getByTestId("standing-label")).toHaveText(practiceName);
    // THE VERB STAYS ON THE BUTTON, unchanged by this fix — its own span, not
    // folded into the label.
    await expect(row.getByText("Open", { exact: true })).toBeVisible();
  } finally {
    if (protocolId)
      db.prepare("DELETE FROM protocols WHERE id = ?").run(protocolId);
    db.prepare("DELETE FROM practice_logs WHERE practice = ?").run(
      practiceName
    );
    if (targetId)
      db.prepare("DELETE FROM frequency_targets WHERE id = ?").run(targetId);
    db.close();
  }
});
