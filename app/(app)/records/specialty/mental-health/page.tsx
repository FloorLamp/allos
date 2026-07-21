import { requireSession } from "@/lib/auth";
import MentalHealthSection from "../../MentalHealthSection";
import { SectionSubtitle } from "../../SectionHeader";

export const dynamic = "force-dynamic";

// Health record › Specialty › Mental health (#1079). Always renders — the in-app
// instrument flow is the only creation path. The #716 crisis line is CONTENT and
// travels with this route (the safety contract is content, not route).
export default async function RecordsMentalHealthPage() {
  const { login, profile } = await requireSession();
  return (
    <div data-testid="records-mental-health">
      <SectionSubtitle>
        Track validated screening instruments — PHQ-9 and GAD-7 — as
        severity-banded scores over time. A screening tool, not a diagnosis.
        Informational, not medical advice.
      </SectionSubtitle>
      <MentalHealthSection
        profileId={profile.id}
        isAdmin={login.role === "admin"}
      />
    </div>
  );
}
