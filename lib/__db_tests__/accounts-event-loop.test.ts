import { setTimeout as delay } from "node:timers/promises";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { expect, it } from "vitest";
import { db } from "@/lib/db";
import { portalAccountCoverage } from "@/lib/portal-visibility";
import { usesRealElapsedTime } from "./frozen-clock";

usesRealElapsedTime("Measure event-loop delay while reading account coverage");

it("keeps account success lookups below Deck's 200 ms budget with a large sync ledger", async () => {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("Fake lag fixture")
      .lastInsertRowid
  );
  const portalId = Number(
    db
      .prepare("INSERT INTO portals (slug, name) VALUES (?, ?)")
      .run("fake-lag-portal", "Fake lag portal").lastInsertRowid
  );
  const accounts = Array.from({ length: 30 }, (_, i) =>
    Number(
      db
        .prepare(
          "INSERT INTO portal_accounts (portal_id, slug, name) VALUES (?, ?, ?)"
        )
        .run(portalId, `fake-${i}`, `Fake account ${i}`).lastInsertRowid
    )
  );
  const successAt = "2026-10-15T00:00:00.000Z";
  db.prepare(
    `INSERT INTO integration_sync_events
    (profile_id, source_id, account_id, at, ok)
    VALUES (?, 'patient-portals', ?, ?, 1)`
  ).run(profileId, accounts[0], successAt);
  // A never-successful account must not scan every failed run on every refresh.
  db.prepare(
    `WITH RECURSIVE n(x) AS (
    VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < 100000
  ) INSERT INTO integration_sync_events (profile_id, source_id, at, ok)
    SELECT ?, 'patient-portals', '2026-10-16T00:00:00.000Z', 0 FROM n`
  ).run(profileId);
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  try {
    await delay(30);
    for (const account of accounts) {
      expect(portalAccountCoverage(profileId, account).lastSuccess).toBe(
        account === accounts[0] ? successAt : null
      );
    }
    await delay(30);
    expect(lag.count).toBeGreaterThan(0);
    expect(lag.max / 1e6).toBeLessThan(200);
  } finally {
    lag.disable();
  }
});
