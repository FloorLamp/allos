import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath, frozenNow } from "./worker-env";
import { utcInstant, zonedWallTimeToUtc } from "../lib/date";

// TEMPORARY measurement harness for the #2612/#2614 before/after numbers.
// Deleted before the PR — it prints, it does not assert.

const STACK = [
  "E2e Fold Creatine",
  "E2e Fold Whey",
  "E2e Fold Iron",
  "E2e Fold Calcium",
  "E2e Fold Magnesium",
  "E2e Fold Zinc",
];
const PROFILE = 1;

function openDb(): Database.Database {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  return db;
}

function localDay(tz: string, offset: number): string {
  const at = new Date(frozenNow().getTime() + offset * 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(at);
}

test("MEASURE", async ({ page }) => {
  test.slow();
  const db = openDb();
  const names = STACK.map(() => "?").join(",");
  db.prepare(
    `DELETE FROM intake_item_logs WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ? AND name IN (${names}))`
  ).run(PROFILE, ...STACK);
  db.prepare(
    `DELETE FROM intake_items WHERE profile_id = ? AND name IN (${names})`
  ).run(PROFILE, ...STACK);
  const tzRow = db
    .prepare(
      `SELECT value FROM profile_settings WHERE profile_id = ? AND key = 'timezone'`
    )
    .get(PROFILE) as { value: string } | undefined;
  const tz = tzRow?.value || "UTC";
  const row = db
    .prepare(
      `SELECT id, start_date FROM illness_episodes WHERE profile_id = ? AND end_date IS NULL
        ORDER BY start_date IS NULL, start_date DESC, id DESC LIMIT 1`
    )
    .get(PROFILE) as { id: number; start_date: string | null };
  const today = localDay(tz, 0);
  const start = row.start_date ?? today;
  const days: string[] = [];
  for (let offset = -30; offset <= 0; offset += 1) {
    const day = localDay(tz, offset);
    if (day >= start && day <= today) days.push(day);
  }
  let logs = 0;
  STACK.forEach((name, index) => {
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
           VALUES (?, ?, 1, 'supplement', 'daily', 'may')`
        )
        .run(PROFILE, name).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 serving', 'anytime', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    for (const day of days) {
      const clock = `0${7 + index}`.slice(-2);
      const occurred = zonedWallTimeToUtc(tz, day, `${clock}:05`)!;
      db.prepare(
        `INSERT INTO intake_item_logs (dose_id, item_id, date, occurred_at, status, amount)
         VALUES (?, ?, ?, ?, 'taken', '1 serving')`
      ).run(doseId, itemId, day, utcInstant(occurred));
      logs += 1;
    }
  });
  db.close();

  await page.goto(`/medical/episodes/${row.id}`);
  await expect(page.getByTestId("episode-illness-timeline")).toBeVisible();
  const episode = await page.evaluate(() => ({
    docHeight: document.documentElement.scrollHeight,
    caption:
      document
        .querySelector('[data-testid="fever-chart-doses"]')
        ?.getBoundingClientRect().height ?? -1,
    laidOutRows: [
      ...document.querySelectorAll(
        '[data-testid="episode-illness-timeline"] tbody tr'
      ),
    ].filter((r) => (r as HTMLElement).offsetParent !== null).length,
  }));
  console.log(
    `MEASURE episode days=${days.length} doses=${logs} docHeight=${episode.docHeight} captionH=${Math.round(episode.caption)} laidOutRows=${episode.laidOutRows}`
  );

  await page.goto("/trends");
  const strip = await page
    .getByTestId("trends-tabs")
    .evaluate((n) => ({ scrollW: n.scrollWidth, clientW: n.clientWidth }));
  console.log(
    `MEASURE trends strip scrollWidth=${strip.scrollW} clientWidth=${strip.clientW}`
  );

  await page.goto("/sleep");
  const sleep = await page
    .getByTestId("sleep-history-scroll-fade")
    .evaluate((n) => ({ scrollW: n.scrollWidth, clientW: n.clientWidth }));
  console.log(
    `MEASURE sleep scroller scrollWidth=${sleep.scrollW} clientWidth=${sleep.clientW}`
  );

  await page.goto("/import/908");
  const imp = await page
    .locator('[data-testid="extracted-observations"] table')
    .evaluate((n) => {
      const p = n.parentElement!;
      return { scrollW: p.scrollWidth, clientW: p.clientWidth };
    });
  console.log(
    `MEASURE import scroller scrollWidth=${imp.scrollW} clientWidth=${imp.clientW}`
  );

  await page.goto("/");
  const labs = await page.evaluate(() => {
    const links = [
      ...document.querySelectorAll('a[href^="/results/readings/view"]'),
    ];
    return links
      .map((l) => {
        const b = l.getBoundingClientRect();
        return `${l.textContent?.trim()}|box=${Math.round(b.width)}|full=${(l as HTMLElement).scrollWidth}`;
      })
      .slice(0, 8);
  });
  console.log(`MEASURE recent labs ${JSON.stringify(labs)}`);

  const cleanup = openDb();
  cleanup
    .prepare(
      `DELETE FROM intake_item_logs WHERE item_id IN (SELECT id FROM intake_items WHERE profile_id = ? AND name IN (${names}))`
    )
    .run(PROFILE, ...STACK);
  cleanup
    .prepare(`DELETE FROM intake_items WHERE profile_id = ? AND name IN (${names})`)
    .run(PROFILE, ...STACK);
  cleanup.close();
});
