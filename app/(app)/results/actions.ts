"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import { requireScope } from "@/lib/scope";
import { dismissFinding } from "@/lib/queries";
import { parsePanelId } from "@/lib/biomarker-panels";
import {
  clinicalResultIndexRows,
  clinicalResultPanelRows,
  parseClinicalResultFilters,
  type ClinicalResultsSearchParams,
  type ClinicalResultTableObservation,
} from "./clinical-result-index";

// Dismiss a biomarker trajectory finding (issues #41/#564), from the Results →
// Biomarkers "Trajectory watch" rollup (#1164 moved the area here from the deleted
// Trends → Biomarkers tab; #1499 folded it into one capped card). The flag and the
// trajectory are two views of one concern about one analyte, so this writes the
// SHARED analyte-level acknowledgment key ("biomarker-flag:<family>") the finding
// carries as `supersedes` — silencing BOTH the trajectory watch and the analyte's
// dashboard flag ("dismiss once, silence everywhere"), at the #482 family level so it
// covers D2/D3/total. Guarded to the flag namespace so this action can only ever
// write a biomarker acknowledgment key; profile-scoped via dismissFinding.
//
// It is ALSO what the clinical-result page's "Seen it" posts (#3225): that control
// writes the identical analyte acknowledgment, so giving it a second action would be
// two spellings of one write. The name is narrower than the job — see the key's own
// header in lib/dismissal-keys.ts for what the key actually covers. Since #3225 the
// acknowledgment is no longer indefinite: the next draw of the family re-arms it,
// which is decided on the READ side (lib/queries/upcoming/suppressions.ts), so
// nothing here changes.
//
// The field is `dedupe_key`, the name every findings-bus dismiss form posts (the
// shared components/FindingRow renders it) — `ack_key` was this surface's own
// spelling for the same thing and is still accepted so an in-flight form submitted
// across a deploy is not silently dropped. Returns void, matching its Training-watch
// sibling `dismissTrainingObservation`: the rollup rows are FindingRow forms, whose
// action contract is a plain server action, and no caller ever read the old result.
export async function dismissTrajectory(formData: FormData): Promise<void> {
  const { profile } = await requireWriteAccess();
  const ackKey = String(
    formData.get("dedupe_key") ?? formData.get("ack_key") ?? ""
  ).trim();
  if (!ackKey.startsWith("biomarker-flag:")) return;
  dismissFinding(profile.id, ackKey);
  revalidateRoute("/results/clinical-results");
  // The result detail page renders the acknowledgment state ("Seen it" vs "Seen —
  // until the next draw"), so it has to be purged too or the control it was pressed
  // on keeps offering itself.
  revalidateRoute("/results/clinical-results/view", "page");
  revalidateRoute("/");
}

// The clinical results in ONE panel group, loaded when the reader expands it (#1651).
//
// The index arrives with its rows BOUNDED — a collapsed group ships none, an open
// one ships at most PANEL_ROW_LIMIT — because props handed to a client component are
// serialized into the RSC payload whatever that component renders, so "collapsed"
// alone never reduced what was downloaded. Asking for a panel is the user action that
// pays for that panel's rows, and only that panel's.
//
// Authorization is resolved HERE, at the request boundary, exactly as the page does
// it: requireScope() returns the persisted, access-validated view, and the gather
// runs against that scope — this action can only ever return rows the same reader's
// page render would have shown. The `panel` argument is validated against the closed
// PanelId set, and the filters are re-parsed by the SAME parser the page used, so an
// edited request can only ever name a real panel and a real filter set.
export async function loadClinicalResultPanelRows(input: {
  panel: string;
  searchParams: ClinicalResultsSearchParams;
}): Promise<
  | { ok: true; rows: ClinicalResultTableObservation[] }
  | { ok: false; error: string }
> {
  const scope = await requireScope();
  const panel = parsePanelId(input.panel);
  if (!panel) return { ok: false, error: "Unknown panel." };
  const filters = parseClinicalResultFilters(input.searchParams ?? {});
  const rows = clinicalResultIndexRows(scope, filters);
  // Plain serializable records: prepareTableObservations rebuilds every row as a new
  // object, so no better-sqlite3 row proxy crosses back to the client.
  return { ok: true, rows: clinicalResultPanelRows(rows, panel) };
}
