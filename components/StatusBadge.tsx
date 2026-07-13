import { statusTone, titleCase } from "@/lib/record-format";

// Shared clinical-status pill (#643). The "Status" column on the parallel
// clinical lists (conditions, allergies, care-plan, care-goals) used to disagree —
// some rendered a color-coded badge, others bare grey text — so the SAME status
// looked different depending on the page. This is the single presentation: one
// per-status color (via statusTone) and normalized casing (via titleCase), so an
// "active" condition and an "active" care goal read identically. A null/empty
// status renders the muted em-dash placeholder the plain-text cells used.
export default function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="text-slate-400">—</span>;
  return (
    <span className={`badge ${statusTone(status)}`}>{titleCase(status)}</span>
  );
}
