export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    const { startMetrics } = await import("./lib/metrics-runtime");
    const { db } = await import("./lib/db");
    const { seedSyncMetrics } = await import("./lib/integrations/connections");
    // System startup is authorized to read operational state for every profile.
    const profiles = db.prepare("SELECT id FROM profiles").all() as {
      id: number;
    }[];
    for (const profile of profiles) seedSyncMetrics(profile.id);
    startMetrics();
  }
}
