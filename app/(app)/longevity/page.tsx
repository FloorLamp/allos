import Link from "next/link";
import {
  IconActivityHeartbeat,
  IconFlask2,
  IconMoonStars,
  IconRun,
  IconTestPipe,
} from "@tabler/icons-react";
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
import PageContainer from "@/components/PageContainer";

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
  // A durable starter-template deep link (issue #571), expanding and seeding the
  // otherwise-collapsed add form. Null when no/unknown template is requested.
  const template = protocolTemplateById((await searchParams).template);

  return (
    <PageContainer width="wide" className="mx-auto">
      <PageHeader
        title="Longevity"
        subtitle="Follow the signals that shape healthspan, then test what moves them."
      />

      {sections.length > 0 && (
        <nav
          aria-label="Longevity sections"
          className="-mx-1 mb-5 flex gap-2 overflow-x-auto px-1 pb-1"
        >
          {sections.map((section) => (
            <Link
              key={section.anchor}
              href={`#${section.anchor}`}
              className="btn-ghost btn-sm shrink-0"
            >
              {section.title}
            </Link>
          ))}
          <Link href="#protocols" className="btn-ghost btn-sm shrink-0">
            <IconFlask2 className="h-4 w-4" aria-hidden />
            Protocols
          </Link>
        </nav>
      )}

      <div className="space-y-6">
        <BioAgeSection />
        {fitness && <FitnessSection section={fitness} />}
        {sleep && <SleepSection section={sleep} />}
        {biomarkers && <BiomarkersSection section={biomarkers} />}

        {pillars.length === 0 && (
          <section
            className="card overflow-hidden border-brand-100 dark:border-brand-950"
            data-testid="longevity-empty"
          >
            <div className="flex items-start gap-3">
              <span className="rounded-xl bg-brand-50 p-2.5 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
                <IconActivityHeartbeat className="h-5 w-5" aria-hidden />
              </span>
              <div>
                <h2 className="font-semibold text-slate-900 dark:text-slate-100">
                  Build your healthspan picture
                </h2>
                <p className="mt-1 max-w-2xl text-sm text-slate-600 dark:text-slate-300">
                  Your overview appears as data arrives. Start with any signal;
                  there is no single longevity score to chase.
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <Link
                href="/data"
                className="flex items-center gap-3 rounded-lg border border-black/5 bg-white/45 px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-white/5 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-ink-800"
              >
                <IconTestPipe
                  className="h-4 w-4 shrink-0 text-brand-500"
                  aria-hidden
                />
                Import lab results
              </Link>
              <Link
                href="/sleep"
                className="flex items-center gap-3 rounded-lg border border-black/5 bg-white/45 px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-white/5 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-ink-800"
              >
                <IconMoonStars
                  className="h-4 w-4 shrink-0 text-violet-500"
                  aria-hidden
                />
                Add sleep data
              </Link>
              <Link
                href="/training?tab=fitness"
                className="flex items-center gap-3 rounded-lg border border-black/5 bg-white/45 px-3 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-100 dark:border-white/5 dark:bg-white/5 dark:text-slate-200 dark:hover:bg-ink-800"
              >
                <IconRun
                  className="h-4 w-4 shrink-0 text-rose-500"
                  aria-hidden
                />
                Run a fitness check
              </Link>
            </div>
          </section>
        )}

        <ProtocolsSection template={template} />
      </div>
    </PageContainer>
  );
}
