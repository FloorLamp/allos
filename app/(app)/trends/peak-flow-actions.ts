"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import { setPeakFlowPersonalBest } from "@/lib/settings";
import { PEAK_FLOW_SLUG } from "@/lib/peak-flow";

// The peak-flow personal best (#1850) — the one number the green/yellow/red zones are
// a percentage OF.
//
// A Server Action rather than a settings-page form because the value belongs where it
// is READ: the zone on the metric detail page is meaningless without it, and a person
// who has just blown into a meter is on that page, not in Settings. The STORAGE is
// still the profile tier (`profile_settings`, no schema) — the surface moved, the tier
// did not.
//
// Authorization at the boundary, the write core auth-blind (lib/settings), exactly as
// the house rules require. A blank submission CLEARS the best, which is a first-class
// state: with it unset every surface goes back to showing no verdict rather than a
// stale one.
export async function savePeakFlowPersonalBest(formData: FormData) {
  const { profile } = await requireWriteAccess();
  const raw = String(formData.get("personal_best") ?? "").trim();
  if (raw === "") {
    setPeakFlowPersonalBest(profile.id, null);
  } else {
    const n = Number(raw);
    // The core re-checks the plausibility window and refuses an out-of-range value;
    // a non-numeric one never reaches it.
    if (!Number.isFinite(n)) return;
    setPeakFlowPersonalBest(profile.id, n);
  }
  // Interpolated so the #1636 sweep resolves it against the dynamic `[kind]` route,
  // the same form every other metric-scoped revalidate here takes.
  revalidateRoute(`/trends/metric/${PEAK_FLOW_SLUG}`);
  revalidateRoute("/trends");
}
