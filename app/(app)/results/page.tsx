import { requireSession } from "@/lib/auth";
import { PageHeader } from "@/components/ui";
import BiomarkersSection, {
  type BiomarkersSearchParams,
} from "./BiomarkersSection";
import ImagingSection from "./ImagingSection";
import GenomicsSection from "./GenomicsSection";

export const dynamic = "force-dynamic";

// Results (#1042 phase 5): the three read-heavy result stores — the Biomarkers
// analyte browser, Imaging studies, and Genomic variants — merged into ONE
// stacked-section page at real anchors (/results#biomarkers, #imaging,
// #genomics). The removed index routes 308-redirect here with their anchor
// (next.config.js); the DETAIL routes survive unchanged (/biomarkers/view, the
// per-biomarker series page). Each section reuses the former index page's
// content component (moved, not rewritten); Server Actions stayed in their
// route-independent modules (app/(app)/{biomarkers,imaging,genomics}/actions.ts).
//
// Section visibility mirrors the nav (#1042 rule: a hidden nav child must never
// be a visible section): none of the three constituent leaves carried a nav gate
// (no relevanceKey / age / multi-profile flag), so all three sections always
// render — each with its own empty state when the profile has no rows.
//
// With only three sections, a simple anchor-linked jump row replaces the sticky
// jump-link bar the (much larger) Health-record merge uses.

const SECTIONS = [
  { id: "biomarkers", label: "Biomarkers" },
  { id: "imaging", label: "Imaging" },
  { id: "genomics", label: "Genomics" },
] as const;

function SectionHeader({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="mb-6">
      <h2 className="text-2xl font-bold text-slate-900 dark:text-slate-100">
        {title}
      </h2>
      <div className="mt-1 text-sm text-slate-500 dark:text-slate-400">
        {subtitle}
      </div>
    </div>
  );
}

export default async function ResultsPage(props: {
  searchParams: Promise<BiomarkersSearchParams>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();

  return (
    <div>
      <PageHeader
        title="Results"
        subtitle="Your result records in one place — labs and biomarkers, imaging studies, and genomic variants."
      />

      {/* Anchor jump row — plain in-page fragment links. */}
      <nav
        aria-label="Results sections"
        data-testid="results-jump-links"
        className="mb-8 flex flex-wrap gap-2"
      >
        {SECTIONS.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-full border border-black/10 bg-white/80 px-3 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-300 dark:hover:bg-ink-750"
          >
            {s.label}
          </a>
        ))}
      </nav>

      <section
        id="biomarkers"
        data-testid="results-biomarkers"
        className="scroll-mt-20"
      >
        <SectionHeader
          title="Biomarkers"
          subtitle="Explore your results, track each biomarker over time, and star the ones you watch."
        />
        <BiomarkersSection profileId={profile.id} searchParams={searchParams} />
      </section>

      <section
        id="imaging"
        data-testid="results-imaging"
        className="mt-12 scroll-mt-20"
      >
        <SectionHeader
          title="Imaging"
          subtitle="Your radiology studies — modality, region, laterality, contrast, and the radiologist's impression. Add them manually or import an uploaded report. Numeric imaging measurements (DEXA T-scores, calcium score) still live in Biomarkers."
        />
        <ImagingSection profileId={profile.id} />
      </section>

      <section
        id="genomics"
        data-testid="results-genomics"
        className="mt-12 scroll-mt-20"
      >
        <SectionHeader
          title="Genomic variants"
          subtitle="Structured genetic results captured from clinical genetics / pharmacogenomic reports. Add them manually or import an uploaded report. Raw consumer-genotype files (23andMe / Ancestry / VCF) aren't parsed."
        />
        <GenomicsSection profileId={profile.id} />
      </section>
    </div>
  );
}
