import { requireSession } from "@/lib/auth";
import { getHealthspanPillars } from "@/lib/queries";
import { longevitySections } from "@/lib/longevity";
import { protocolTemplateById } from "@/lib/protocol-templates";
import { PageHeader } from "@/components/ui";
import BioAgeSection from "./BioAgeSection";
import FitnessSection from "./FitnessSection";
import SleepSection from "./SleepSection";
import BiomarkersSection from "./BiomarkersSection";
import ProtocolsSection from "./ProtocolsSection";

export const dynamic = "force-dynamic";

// The Longevity page (#1042 phase 4): the EXPANDED formatter over the SAME
// healthspan-pillar model the dashboard HealthspanPillarsWidget compact-renders
// (one model, two formatters — the #221 digest/recap precedent; identity pinned
// by lib/__tests__/longevity-sections.test.ts). Deliberately PILLARS, not a
// composite score — no invented single number anywhere on this page.
//
// Membership test (issue #1042): a section belongs iff it's a pillar in the
// model or an INTERVENTION against one. Absent pillars don't render — a section
// materializes only when longevitySections finds its pillar(s) in the model
// (the #bio-age wrapper additionally renders its missing-inputs checklist via
// the shared bioAgeSurface decision), and #protocols (the absorbed /protocols
// hub — the interventions arm) always renders, since it's also the creation
// surface for a first experiment. Each section carries a stable anchor id the
// widget's pillar cards deep-link to (pillarHref).
export default async function LongevityPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>;
}) {
  const { profile } = await requireSession();
  const pillars = getHealthspanPillars(profile.id);
  const sections = longevitySections(pillars);
  const byAnchor = new Map(sections.map((s) => [s.anchor, s]));
  const fitness = byAnchor.get("fitness");
  const sleep = byAnchor.get("sleep");
  const biomarkers = byAnchor.get("biomarkers");
  // A starter protocol template (issue #571) selected from the templates strip,
  // seeding the add form. Null when no/unknown template is requested.
  const template = protocolTemplateById((await searchParams).template);

  return (
    <div>
      <PageHeader
        title="Longevity"
        subtitle="Evidence-backed healthspan pillars — each expands below as its data arrives — and the N-of-1 experiments you run against them. Pillars, never a composite score."
      />

      <BioAgeSection />
      {fitness && <FitnessSection section={fitness} />}
      {sleep && <SleepSection section={sleep} />}
      {biomarkers && <BiomarkersSection section={biomarkers} />}

      {pillars.length === 0 && (
        <p
          className="mb-6 text-sm text-slate-500 dark:text-slate-400"
          data-testid="longevity-empty"
        >
          No pillars yet — they appear as their data arrives: labs for
          biological age and optimal-range share, sleep sessions for regularity,
          and a fitness check or VO₂ reading for fitness percentiles.
        </p>
      )}

      <ProtocolsSection template={template} />
    </div>
  );
}
