import { getDataset, toCsv, RESTRICTED_DATASETS } from "@/lib/export";
import { getCurrentSession } from "@/lib/auth";
import { isTrainingRestricted } from "@/lib/age-gate";
import { recordAudit } from "@/lib/audit";
import { AUDIT_ACTIONS } from "@/lib/audit-actions";

export const dynamic = "force-dynamic";

// GET /api/export/<dataset> — stream the dataset as a downloadable CSV.
export async function GET(
  _req: Request,
  props: { params: Promise<{ dataset: string }> }
) {
  const params = await props.params;
  // Cookie-authoritative gate: this exposes full medical/biomarker data, so the
  // Edge middleware's coarse cookie-presence check isn't enough here.
  const session = await getCurrentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const ds = getDataset(params.dataset);
  if (!ds) return new Response("Unknown dataset", { status: 404 });

  // Age gate at the AUTHORITATIVE layer, not just the export UI (issue #471): a
  // training-restricted profile can't pull the fitness datasets even by hitting the
  // route directly. 404 (indistinguishable from an unknown dataset) rather than 403,
  // matching the rest of the app's "hidden, not forbidden" gating.
  if (
    RESTRICTED_DATASETS.has(ds.key) &&
    isTrainingRestricted(session.profile.id)
  ) {
    return new Response("Unknown dataset", { status: 404 });
  }

  const rows = ds.rows(session.profile.id);
  // Audit the egress (issue #471): this serves the identical full-table PHI as the
  // ZIP, so "someone exported the whole <dataset>" is logged here too, not only on
  // the ZIP path. detail records how many rows left the app.
  recordAudit({
    loginId: session.login.id,
    profileId: session.profile.id,
    action: AUDIT_ACTIONS.exportDataset,
    target: ds.key,
    detail: String(rows.length),
  });

  const csv = toCsv(ds.columns, rows);
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ds.key}-${date}.csv"`,
    },
  });
}
