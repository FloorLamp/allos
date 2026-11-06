import { expect, it, vi } from "vitest";
import { db } from "@/lib/db";
import { seedSyncMetrics } from "@/lib/integrations/connections";

// Every metrics scrape seeds every profile on the web process's event loop. Its
// last-success read must stay inside a success-only index, never touching the
// 90 days of ledger rows (failed runs, details JSON) behind it.
it("seeds sync successes from a covering index, not the sync ledger's rows", () => {
  const prepare = vi.spyOn(db, "prepare");
  try {
    seedSyncMetrics(1);
    const sql = prepare.mock.calls[0][0];
    const plan = (
      db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 1, 1) as {
        detail: string;
      }[]
    )
      .map((row) => row.detail)
      .filter((detail) => detail.includes("integration_sync_events"));
    expect(plan).toEqual([
      expect.stringContaining("USING COVERING INDEX idx_sync_events_success"),
    ]);
  } finally {
    prepare.mockRestore();
  }
});
