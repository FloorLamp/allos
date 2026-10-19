export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { startMetrics } = await import("./lib/metrics-runtime");
    const { db } = await import("./lib/db");
    const { seedSyncMetrics } = await import("./lib/integrations/connections");
    startMetrics(() => {
      // The metrics boundary is authorized to read operational state for every profile.
      // Scheduled syncs run in the notify process, so refresh persisted successes
      // on each scrape rather than only at web startup.
      const profiles = db.prepare("SELECT id FROM profiles").all() as {
        id: number;
      }[];
      for (const profile of profiles) seedSyncMetrics(profile.id);
    });
  }
}
