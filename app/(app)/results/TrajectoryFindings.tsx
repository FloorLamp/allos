import { requireSession } from "@/lib/auth";
import { today } from "@/lib/db";
import { getFindingSuppressions } from "@/lib/queries";
import { buildTrajectoryFindings } from "@/lib/trajectory-series";
import { activeFindings } from "@/lib/findings";
import TrajectoryWatchCard from "./TrajectoryWatchCard";
import { dismissTrajectory } from "./actions";

// Biomarker trajectory findings (issue #41) for the Results → Biomarkers section
// (#1164 moved it here from the deleted Trends → Biomarkers tab). Runs the pure
// trajectory rules over the profile's per-analyte history and lists the active ones
// — an in-range value projected to cross a boundary, a persistent non-optimal
// pattern, or a concerning velocity — BEFORE a single-value flag would catch them.
// Each observation shows its numbers and a "worth discussing with your clinician"
// framing, links to the biomarker's detail (schedule a retest), and can be dismissed
// through the shared findings-bus suppression store. Nothing renders when no
// trajectory is firing.
//
// #1499 section B: those observations render as ONE capped rollup card grouped per
// analyte (TrajectoryWatchCard over the pure lib/trajectory-rollup) instead of ~10
// sibling blocks. Rendering only — the engine, the dedupeKeys and the dismiss action
// below are untouched, so a dismiss inside the rollup is the same write to the same
// bus it always was.
export default async function TrajectoryFindings() {
  const { profile } = await requireSession();
  const now = today(profile.id);
  // activeFindings (not activeByKey) so a finding is suppressed by EITHER its own
  // `trajectory:<analyte>:<rule>` dedupeKey OR the shared `biomarker-flag:<family>`
  // acknowledgment it carries as `supersedes` (#564) — so dismissing the analyte's
  // flag on the dashboard silences its trajectory watch here too.
  const findings = activeFindings(
    buildTrajectoryFindings(profile.id, now),
    getFindingSuppressions(profile.id),
    now
  );
  return (
    <TrajectoryWatchCard
      findings={findings}
      dismissAction={dismissTrajectory}
    />
  );
}
