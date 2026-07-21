import { requireSession, getAccessibleProfiles } from "@/lib/auth";
import { getNavRelevance } from "@/lib/queries/nav-relevance";
import { PageHeader } from "@/components/ui";
import ConditionsSection from "./ConditionsSection";
import AllergiesSection from "./AllergiesSection";
import ProceduresSection from "./ProceduresSection";
import ImmunizationsSection from "./ImmunizationsSection";
import FamilyHistorySection from "./FamilyHistorySection";
import VisitsSection from "./VisitsSection";
import ProvidersSection from "./ProvidersSection";
import BackgroundSection from "./BackgroundSection";
import CarePlanSection from "./CarePlanSection";
import HealthGoalsSection from "./HealthGoalsSection";
import CoverageAnchorRedirect from "./CoverageAnchorRedirect";
import VisionSection from "./VisionSection";
import DentalSection from "./DentalSection";
import SkinSection from "./SkinSection";
import MentalHealthSection from "./MentalHealthSection";

export const dynamic = "force-dynamic";

// Health record (#1042): the Medical index pages merged into ONE stacked-section
// page at real anchors (/records#conditions, #allergies, … #vision, #mental-health).
// The removed index routes 308-redirect here with their anchor (next.config.js); the
// DETAIL routes survive unchanged (/providers/[id], /encounters/[id],
// /immunizations/[vaccine]). Each section reuses the former index page's content
// component (moved, not rewritten); Server Actions stayed in their route-independent
// modules (app/(app)/{conditions,allergies,vision,dental,skin,medical/instruments}/…).
//
// Ten CORE sections (Conditions … Health goals) always render — none of their
// leaves carried a nav gate — each with its own empty state. (Coverage gaps was a
// core section through #1042 phase 6; #1086 moved it to Data → Coverage as
// catalog/data-management, not a clinical record.) The four SPECIALTY
// sections (Vision/Dental/Skin/Mental health — the #1042 "final tail") fold in AFTER
// them, and section visibility mirrors the nav predicate (#1042 rule: a hidden nav
// child must never be a visible section):
//   - Vision / Dental gate on DATA PRESENCE — the same predicate their former
//     data-gated nav leaves used (getNavRelevance). Their rows also arrive via
//     Data → Import (an always-visible creation path), so hiding an empty section
//     never strands creation.
//   - Skin / Mental health render UNCONDITIONALLY — their former nav leaves were
//     ungated, and their in-page forms (the lesion form / the in-app instrument flow)
//     are the ONLY creation path, so hiding them would strand a new tracker. Mental
//     health also carries the #716 crisis line, whose safety contract is content, not
//     route — it travels with the always-rendered section.
// A gated-hidden section drops BOTH its <section> and its sticky jump-link.
//
// A STICKY jump-link row (the issue names it for this large merge) is the page's
// primary in-page nav; sections carry `scroll-mt` so an anchored jump clears it.

const SECTIONS = [
  {
    id: "conditions",
    label: "Conditions",
    title: "Conditions",
    subtitle:
      "Your problem list — active conditions and diagnoses, coded (ICD-10 / SNOMED) when imported from a health record.",
  },
  {
    id: "allergies",
    label: "Allergies",
    title: "Allergies",
    subtitle:
      "Documented allergies plus allergen-specific IgE sensitizations detected from your labs. A key emergency-card field.",
  },
  {
    id: "procedures",
    label: "Procedures",
    title: "Procedures",
    subtitle:
      "Your procedure & surgical history — coded (CPT / SNOMED) when imported from a health record. Add them manually or import from uploaded records (CCD Procedures section).",
  },
  {
    id: "immunizations",
    label: "Immunizations",
    title: "Immunizations",
    subtitle:
      "Your vaccination record measured against a simplified CDC/ACIP schedule — informational only, not medical advice.",
  },
  {
    id: "family-history",
    label: "Family history",
    title: "Family history",
    subtitle:
      "Conditions affecting your relatives — hereditary risk context, coded when imported from a health record. Add entries manually or import from uploaded records (CCD Family History section).",
  },
  {
    id: "visits",
    label: "Visits",
    title: "Visits",
    subtitle:
      "Your appointments and visit history in one place — book upcoming visits (they also surface on Upcoming) and review past encounters, diagnoses, and notes.",
  },
  {
    id: "providers",
    label: "Providers",
    title: "Providers",
    subtitle:
      "Your shared registry of clinicians and organizations. Record counts are for the active profile.",
  },
  {
    id: "background",
    label: "Background",
    title: "Background",
    subtitle:
      "Smoking history, health risk factors, and emergency card — person-level context that tailors screening reminders and the offline emergency summary.",
  },
  {
    id: "care-plan",
    label: "Care plan",
    title: "Care plan",
    subtitle:
      "Planned & ordered care from your health records (Plan of Treatment / Care Plan section) — upcoming procedures, visits, tests, and orders. Add them manually or import from uploaded records.",
  },
  {
    id: "health-goals",
    label: "Health goals",
    title: "Health goals",
    subtitle:
      "Clinical goals & targets from your health records (Goals section) — e.g. an A1c or blood-pressure target set by a provider. (Distinct from your personal fitness Goals.)",
  },
] as const;

// The four SPECIALTY sections (#1042 final tail), rendered AFTER the ten core
// sections. Each carries a data/always gate resolved below; a hidden one drops both
// its <section> and its jump-link.
const SPECIALTY_SECTIONS = [
  {
    id: "vision",
    label: "Vision",
    title: "Vision",
    subtitle:
      "Your eyeglass and contact-lens prescriptions — per-eye power, PD, and how your sphere has changed over time. Add them manually or import an uploaded Rx slip.",
  },
  {
    id: "dental",
    label: "Dental",
    title: "Dental",
    subtitle:
      "Your dental procedures and exam findings, anchored to teeth. Add them manually or import a dental record. Periodontal measurements (pocket depth, bleeding) and dental X-rays live on Results.",
  },
  {
    id: "skin",
    label: "Skin",
    title: "Skin",
    subtitle:
      "Track moles and spots over time — a body-map location, size, and your ABCDE observations, with dated photos for side-by-side comparison. Flag one to watch and it becomes a tracked recheck.",
  },
  {
    id: "mental-health",
    label: "Mental health",
    title: "Mental health",
    subtitle:
      "Track validated screening instruments — PHQ-9 and GAD-7 — as severity-banded scores over time. A screening tool, not a diagnosis. Informational, not medical advice.",
  },
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

// The query params consumed by the param-driven sections (Conditions' `?cond`
// filter, Immunizations' `?sort/?dir/?status` table state, and the Visits
// booking-form deep-link params). They all ride the ONE /records URL; a section
// ignores the params it doesn't own. `cond` is namespaced away from Immunizations'
// `status` so the two filters never collide.
type RecordsSearchParams = {
  cond?: string;
  sort?: string;
  dir?: string;
  status?: string;
} & { [key: string]: string | string[] | undefined };

export default async function RecordsPage(props: {
  searchParams: Promise<RecordsSearchParams>;
}) {
  const searchParams = await props.searchParams;
  const { login, profile } = await requireSession();
  // Widen-to-household link on the Visits section — shown only when the login can
  // reach 2+ profiles (the SAME predicate that gates the Household strip/nav).
  const showHousehold = (await getAccessibleProfiles()).length > 1;

  // Section visibility mirrors the nav predicate (#1042). Vision/Dental gate on data
  // presence (getNavRelevance — the SAME computation their former data-gated nav
  // leaves used); Skin/Mental health render unconditionally (their former nav leaves
  // were ungated + their in-page forms are the only creation path).
  const relevance = getNavRelevance(profile.id);
  const specialtyVisible: Record<string, boolean> = {
    vision: relevance.vision,
    dental: relevance.dental,
    skin: true,
    "mental-health": true,
  };
  const visibleSpecialty = SPECIALTY_SECTIONS.filter(
    (s) => specialtyVisible[s.id]
  );
  const jumpSections = [...SECTIONS, ...visibleSpecialty];

  const one = (v: string | string[] | undefined): string | undefined =>
    Array.isArray(v) ? v[0] : v;

  return (
    <div>
      {/* Bridge a stale /records#coverage bookmark to Data → Coverage (#1086) —
          a URL fragment never reaches the server, so this client shim handles it. */}
      <CoverageAnchorRedirect />
      <PageHeader
        title="Health record"
        subtitle="Your health record in one place — conditions, allergies, procedures, immunizations, family history, visits, providers, background, care plan, health goals, vision, dental, skin, and mental health."
      />

      {/* Sticky jump-link row — the page's primary in-page nav. Horizontally
          scrollable so the links never force the body to scroll sideways. Only the
          sections that actually render are linked (a gated specialty section drops
          its link). */}
      <nav
        aria-label="Health record sections"
        data-testid="records-jump-links"
        className="sticky top-0 z-20 -mx-[max(1.25rem,env(safe-area-inset-left))] mb-8 overflow-x-auto border-b border-black/10 bg-white/85 px-[max(1.25rem,env(safe-area-inset-left))] py-2 backdrop-blur-xl dark:border-white/10 dark:bg-ink-950/85"
      >
        <div className="flex w-max gap-2">
          {jumpSections.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="whitespace-nowrap rounded-full border border-black/10 bg-white/80 px-3 py-1 text-sm font-medium text-slate-600 hover:bg-slate-100 dark:border-white/10 dark:bg-ink-900/60 dark:text-slate-300 dark:hover:bg-ink-750"
            >
              {s.label}
            </a>
          ))}
        </div>
      </nav>

      <div className="space-y-12">
        <section
          id="conditions"
          data-testid="records-conditions"
          className="scroll-mt-24"
        >
          <SectionHeader
            title={SECTIONS[0].title}
            subtitle={SECTIONS[0].subtitle}
          />
          <ConditionsSection
            profileId={profile.id}
            cond={one(searchParams.cond)}
          />
        </section>

        <section
          id="allergies"
          data-testid="records-allergies"
          className="scroll-mt-24"
        >
          <SectionHeader
            title={SECTIONS[1].title}
            subtitle={SECTIONS[1].subtitle}
          />
          <AllergiesSection profileId={profile.id} />
        </section>

        <section
          id="procedures"
          data-testid="records-procedures"
          className="scroll-mt-24"
        >
          <SectionHeader
            title={SECTIONS[2].title}
            subtitle={SECTIONS[2].subtitle}
          />
          <ProceduresSection profileId={profile.id} />
        </section>

        <section
          id="immunizations"
          data-testid="records-immunizations"
          className="scroll-mt-24"
        >
          <SectionHeader
            title={SECTIONS[3].title}
            subtitle={SECTIONS[3].subtitle}
          />
          <ImmunizationsSection
            profileId={profile.id}
            searchParams={{
              sort: one(searchParams.sort),
              dir: one(searchParams.dir),
              status: one(searchParams.status),
            }}
          />
        </section>

        <section
          id="family-history"
          data-testid="records-family-history"
          className="scroll-mt-24"
        >
          <SectionHeader
            title={SECTIONS[4].title}
            subtitle={SECTIONS[4].subtitle}
          />
          <FamilyHistorySection profileId={profile.id} />
        </section>

        <section
          id="visits"
          data-testid="records-visits"
          className="scroll-mt-24"
        >
          <SectionHeader
            title={SECTIONS[5].title}
            subtitle={SECTIONS[5].subtitle}
          />
          <VisitsSection
            profileId={profile.id}
            searchParams={searchParams}
            showHousehold={showHousehold}
          />
        </section>

        <section
          id="providers"
          data-testid="records-providers"
          className="scroll-mt-24"
        >
          <SectionHeader
            title={SECTIONS[6].title}
            subtitle={SECTIONS[6].subtitle}
          />
          <ProvidersSection profileId={profile.id} profileName={profile.name} />
        </section>

        <section
          id="background"
          data-testid="records-background"
          className="scroll-mt-24"
        >
          <SectionHeader
            title={SECTIONS[7].title}
            subtitle={SECTIONS[7].subtitle}
          />
          <BackgroundSection profileId={profile.id} />
        </section>

        <section
          id="care-plan"
          data-testid="records-care-plan"
          className="scroll-mt-24"
        >
          <SectionHeader
            title={SECTIONS[8].title}
            subtitle={SECTIONS[8].subtitle}
          />
          <CarePlanSection profileId={profile.id} />
        </section>

        <section
          id="health-goals"
          data-testid="records-health-goals"
          className="scroll-mt-24"
        >
          <SectionHeader
            title={SECTIONS[9].title}
            subtitle={SECTIONS[9].subtitle}
          />
          <HealthGoalsSection profileId={profile.id} />
        </section>

        {/* SPECIALTY sections (#1042 final tail), AFTER the ten core sections.
            Vision/Dental gate on data presence; Skin/Mental health always render. */}
        {specialtyVisible.vision ? (
          <section
            id="vision"
            data-testid="records-vision"
            className="scroll-mt-24"
          >
            <SectionHeader
              title={SPECIALTY_SECTIONS[0].title}
              subtitle={SPECIALTY_SECTIONS[0].subtitle}
            />
            <VisionSection profileId={profile.id} loginId={login.id} />
          </section>
        ) : null}

        {specialtyVisible.dental ? (
          <section
            id="dental"
            data-testid="records-dental"
            className="scroll-mt-24"
          >
            <SectionHeader
              title={SPECIALTY_SECTIONS[1].title}
              subtitle={SPECIALTY_SECTIONS[1].subtitle}
            />
            <DentalSection profileId={profile.id} />
          </section>
        ) : null}

        {specialtyVisible.skin ? (
          <section
            id="skin"
            data-testid="records-skin"
            className="scroll-mt-24"
          >
            <SectionHeader
              title={SPECIALTY_SECTIONS[2].title}
              subtitle={SPECIALTY_SECTIONS[2].subtitle}
            />
            <SkinSection profileId={profile.id} />
          </section>
        ) : null}

        {specialtyVisible["mental-health"] ? (
          <section
            id="mental-health"
            data-testid="records-mental-health"
            className="scroll-mt-24"
          >
            <SectionHeader
              title={SPECIALTY_SECTIONS[3].title}
              subtitle={SPECIALTY_SECTIONS[3].subtitle}
            />
            <MentalHealthSection
              profileId={profile.id}
              isAdmin={login.role === "admin"}
            />
          </section>
        ) : null}
      </div>
    </div>
  );
}
