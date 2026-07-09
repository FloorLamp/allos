import { getCurrentSession } from "@/lib/auth";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";
import { buildFhirBundle } from "@/lib/fhir-export";
import { collectFhirExportInput } from "@/lib/export-full";

// Node runtime: reads the sync SQLite handle.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/export/fhir — the clinical passport (conditions, allergies, procedures,
// immunizations, labs/observations, medications) as a downloadable FHIR R4 Bundle
// (issue #18) — the inverse of lib/fhir.ts's import mapping, so a bundle exported
// here re-imports here. A READ, gated like the per-dataset CSV export.
export async function GET() {
  const session = getCurrentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }
  const profileId = session.profile.id;

  const bundle = buildFhirBundle(
    collectFhirExportInput(profileId, session.profile.name)
  );

  recordAudit({
    loginId: session.login.id,
    profileId,
    action: AUDIT_ACTIONS.exportFhir,
    target: String(bundle.entry.length),
  });

  const date = new Date().toISOString().slice(0, 10);
  return new Response(JSON.stringify(bundle, null, 2), {
    headers: {
      "Content-Type": "application/fhir+json; charset=utf-8",
      "Content-Disposition": `attachment; filename="allos-passport-${date}.fhir.json"`,
      "Cache-Control": "no-store",
    },
  });
}
