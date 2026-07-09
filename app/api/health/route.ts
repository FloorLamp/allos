// Health/readiness endpoint for the Docker healthcheck. Runs a trivial query so
// it actually catches a broken DB (e.g. an unwritable data dir) instead of
// reporting healthy while every real page 500s. The query is cheap on the
// already-open shared connection.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { db } = await import("@/lib/db");
    db.prepare("SELECT 1").get();
    return Response.json({ ok: true });
  } catch (err) {
    // Log the real reason server-side, but return a generic body so the
    // unauthenticated healthcheck doesn't leak DB paths / internals.
    console.error("health check failed", err);
    return Response.json({ ok: false, error: "unhealthy" }, { status: 503 });
  }
}
