import { getSmokingHistory, getRiskAttributes } from "@/lib/settings";
import SmokingHistoryForm from "@/app/(app)/medical/background/SmokingHistoryForm";
import RiskFactorsForm from "@/app/(app)/medical/background/RiskFactorsForm";

// "Background" (former /medical/background index, #1042 phase 6) — the
// person-level medical context that isn't a discrete record: smoking history
// (#83) and health risk factors (#517), now a section of Records › Care ›
// Overview. These moved off Settings → Profile (#928) because they're data ABOUT
// the tracked person, not app configuration (the #343 equipment precedent).
// Storage stays in profile_settings; the forms and their actions are
// profile-scoped + requireWriteAccess. The Emergency Card (#42) settings left this
// section for the Passport (#1087), co-located with the card they configure — so
// Background no longer owns the #emergency-card anchor.
export default function BackgroundSection({
  profileId,
}: {
  profileId: number;
}) {
  // The family's ONE grid (#1449, cluster B). Background used to stack two
  // `max-w-lg` cards in a full-width column, so on Care › Overview it hugged the
  // left at ~40% with the right half empty while the three sections BELOW it used
  // `lg:grid-cols-3` — three grid systems on one scroll, none of whose right edges
  // lined up. Now it is the same 2/1 split: the wider Smoking form (it carries a
  // two-column pack-years/quit-date block) takes the 2-col cell, Risk factors the
  // 1-col cell, and the section's right edge matches its siblings exactly. The
  // `max-w-lg` caps moved OFF the forms — the grid cell is the width discipline now,
  // and a cap inside a sized cell only re-opens the dead space it was meant to fix.
  return (
    <div className="grid gap-6 lg:grid-cols-3">
      <div className="min-w-0 lg:col-span-2">
        <SmokingHistoryForm history={getSmokingHistory(profileId)} />
      </div>
      <div className="min-w-0">
        <RiskFactorsForm attributes={getRiskAttributes(profileId)} />
      </div>
    </div>
  );
}
