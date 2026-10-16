import { GET as health } from "@/app/api/health/route";

export const dynamic = "force-dynamic";

// The Deck backend healthcheck (spaceport shared/backend/health.md): 200 with
// `ok: true` while allos can serve, even degraded. /api/health is the stricter
// container probe — it answers 503 for a stale backup or a filling disk, states a
// person must fix but which do not stop requests — so this folds its verdict into the
// contract's shape: `ok` is "can serve" (the database answers), the probe's own
// `status` and `reason` ride along for houston, and `needs` is `/v1/needs`' list
// (none yet). Same body discipline as /api/health: no paths, versions or PHI.
export async function GET(): Promise<Response> {
  const probe = await health();
  const body = (await probe.json()) as {
    status: string;
    reason?: string;
  };
  const ok = body.reason !== "db-failed";
  return Response.json(
    {
      ok,
      status: body.status,
      ...(body.reason ? { reason: body.reason } : {}),
      needs: [],
    },
    { status: ok ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  );
}
