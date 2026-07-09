import { getDataset, toCsv } from "@/lib/export";
import { getCurrentSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

// GET /api/export/<dataset> — stream the dataset as a downloadable CSV.
export async function GET(
  _req: Request,
  { params }: { params: { dataset: string } }
) {
  // Cookie-authoritative gate: this exposes full medical/biomarker data, so the
  // Edge middleware's coarse cookie-presence check isn't enough here.
  const session = getCurrentSession();
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const ds = getDataset(params.dataset);
  if (!ds) return new Response("Unknown dataset", { status: 404 });

  const csv = toCsv(ds.columns, ds.rows(session.profile.id));
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ds.key}-${date}.csv"`,
    },
  });
}
