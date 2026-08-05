import { getCurrentSession } from "@/lib/auth";
import { getIntegration } from "@/lib/integrations/registry";
import { getIntegrationBackfillJobs } from "@/lib/integrations/backfill-state";
import type { IntegrationId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const session = await getCurrentSession();
  if (!session) {
    return Response.json({ ok: false, error: "auth" }, { status: 401 });
  }
  const provider = new URL(request.url).searchParams.get("provider");
  if (provider && !getIntegration(provider as IntegrationId)) {
    return Response.json(
      { ok: false, error: "Unknown integration." },
      { status: 400 }
    );
  }
  return Response.json(
    {
      ok: true,
      jobs: getIntegrationBackfillJobs(
        session.profile.id,
        provider ?? undefined
      ),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
