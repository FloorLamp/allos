import Link from "next/link";
import { redirect } from "next/navigation";
import { IconArrowLeft } from "@tabler/icons-react";
import { metricDetailHref, BIOMARKERS_LIST_HREF } from "@/lib/hrefs";
import { continuousReadingSlug } from "@/lib/reading-cadence";
import {
  documentLabel,
  getBiomarkerSeriesWithDerived,
  getCanonicalBiomarker,
  getLabFollowUps,
  getIopFollowUps,
  getMedicalDocumentsByIds,
  getFoodSuggestions,
  getCuratedSupplementSuggestions,
  getRevisionsByRecord,
  isBiomarkerSaved,
} from "@/lib/queries";
import {
  fastingLabel,
  resultStatusLabel,
  revisionSummary,
} from "@/lib/lab-result-lifecycle";
import { biomarkerFamily } from "@/lib/canonical-name";
import { getPanelSiblings } from "@/lib/queries/panel-siblings";
import { PanelSiblingsCard } from "@/components/PanelSiblingsCard";
import { isIopBiomarker } from "@/lib/followup-iop";
import TrackLabFollowUpControl from "../TrackLabFollowUpControl";
import FoodSuggestions from "@/components/FoodSuggestions";
import CuratedSupplementSuggestions from "@/components/CuratedSupplementSuggestions";
import type { CanonicalBiomarker, MedicalRecord } from "@/lib/types";
import {
  rangeBadge,
  RANGE_BADGE_META,
  parseReferenceRange,
  plottableReadingValue,
  classifyQualitativeResult,
  isDurableImmunityTiter,
  optimalBand,
  referenceRange,
  selectStatusRange,
  ageBandLabel,
  isBiomarkerStale,
  isOutOfRange,
  daysBetween,
  humanizeAge,
} from "@/lib/reference-range";
import {
  bandNoteClause,
  biomarkerValueBasis,
} from "@/lib/biomarker-value-basis";
import {
  careOfferBasis,
  RECHECK_BASIS_HEADING,
} from "@/lib/biomarker-care-basis";
import { convertToCanonical, sameUnit } from "@/lib/unit-conversions";
import { getBiomarkerInfo } from "@/lib/datasets/biomarker-descriptions";
import {
  getUnitPrefs,
  getUserAgeOn,
  getUserReproductiveStatus,
  getUserSex,
} from "@/lib/settings";
import { degFTo, tempUnitLabel } from "@/lib/units";
import {
  getBiomarkerOutcomeGoals,
  getOutcomeGoalProgressMap,
} from "@/lib/queries";
import {
  biomarkerGoalCheckInText,
  biomarkerGoalCurrentText,
  biomarkerGoalTargetText,
} from "@/lib/biomarker-goal";
import { goalPaceTone, goalPct } from "@/lib/outcome-goals";
import { today } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { PageHeader, EmptyState, MedicalValue } from "@/components/ui";
import { Notice } from "@/components/Notice";
import { type BiomarkerBands } from "@/components/BiomarkerChart";
import BiomarkerTrendChart from "@/components/BiomarkerTrendChart";
import { getProtocolWindowsForOutcome } from "@/lib/queries";
import { buildProtocolWindows } from "@/lib/trend-annotations";
import { buildTrendAnnotations } from "@/lib/trends-series";
import StarButton from "@/components/StarButton";
import { bioSeriesKey } from "@/lib/saved-items";
import ScrollFade from "@/components/ScrollFade";
import {
  FitnessPercentileCard,
  fitnessContextFor,
} from "@/components/FitnessPercentile";

export const dynamic = "force-dynamic";

function formatRange(
  low: number | null,
  high: number | null,
  unit: string | null
): string | null {
  const u = unit ? ` ${unit}` : "";
  // A point band (low === high) is a single target, e.g. "ideally undetectable"
  // toxins pinned at 0 — render it as one value, not "0–0".
  if (low != null && high != null)
    return low === high ? `${low}${u}` : `${low}–${high}${u}`;
  if (high != null) return `≤ ${high}${u}`;
  if (low != null) return `≥ ${low}${u}`;
  return null;
}

// The collection attributes a reading actually states (#1404), as display chips:
// its lifecycle status, its fasting state, its specimen. Empty when the source said
// none of them — an unstated status is NOT "Final", and an unstated fasting state is
// NOT "Non-fasting", so nothing is rendered rather than something invented.
function readingAttributes(r: MedicalRecord): string[] {
  return [
    resultStatusLabel(r.result_status),
    fastingLabel(r.fasting ?? null),
    r.specimen ?? null,
  ].filter((x): x is string => !!x);
}

export default async function BiomarkerDetailPage(props: {
  searchParams: Promise<{ name?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { login, profile } = await requireSession();
  const temperatureUnit = getUnitPrefs(login.id).temperatureUnit;
  const canonical = searchParams.name?.trim();
  // A paramless /biomarkers/view is a degenerate page (#1447): a bare "Biomarker"
  // h1 over "No biomarker selected." and nothing else. It isn't a state anything
  // links to — `readingDetailHref` (lib/hrefs) already returns the LIST route
  // when it has no canonical name — so a hand-typed URL or a stale bookmark lands
  // where that helper would have sent it, rather than on an empty canvas.
  if (!canonical) redirect(BIOMARKERS_LIST_HREF);
  // This page renders EPISODIC readings only (#1932). A continuous vital — SpO2,
  // blood pressure, respiratory rate, body temperature — is read as a trend, not
  // against a lab's reference band, and has its own cadence-appropriate surface;
  // every link to it already resolves there through `readingDetailHref`, so what
  // reaches here is a stale bookmark or a hand-typed URL. It goes where the helper
  // would have sent it, exactly as the paramless case above does. This is
  // current-IA plumbing (both routes are live and serve their own readings), not a
  // compatibility redirect for a retired URL.
  const continuousSlug = continuousReadingSlug(canonical);
  if (continuousSlug) redirect(metricDetailHref(continuousSlug));
  const series = getBiomarkerSeriesWithDerived(profile.id, canonical);

  if (series.length === 0) {
    return (
      <div>
        <Link
          href={BIOMARKERS_LIST_HREF}
          className="mb-4 inline-flex items-center gap-1 text-sm text-brand-700 hover:underline dark:text-brand-400"
        >
          <IconArrowLeft className="h-4 w-4" /> Back to biomarkers
        </Link>
        <PageHeader title={canonical} />
        <EmptyState
          message={`No readings found for “${canonical}”.`}
          action={{ href: BIOMARKERS_LIST_HREF, label: "Browse biomarkers" }}
        />
      </div>
    );
  }

  const cb: CanonicalBiomarker | undefined = getCanonicalBiomarker(canonical);
  const info = getBiomarkerInfo(canonical);
  // Deterministic food suggestions for THIS biomarker (issue #577): the same
  // getFoodSuggestions computation the coaching rollup reads, filtered to the
  // suggestions this flagged biomarker triggered. Food-first, safety-screened,
  // informational. Shown only when this reading is currently flagged low.
  const canonicalLower = canonical.toLowerCase();
  const foodSuggestions = getFoodSuggestions(profile.id).filter((s) =>
    s.triggeredBy.some((n) => n.toLowerCase() === canonicalLower)
  );
  // The supplement twin (issue #2378), same discipline: the SAME
  // getCuratedSupplementSuggestions computation the supplements tab reads, filtered to
  // what THIS flagged biomarker triggered. Curated, safety-screened, dose-free — and
  // badged as curated so it can never be mistaken for the AI route's output.
  const curatedSupplementSuggestions = getCuratedSupplementSuggestions(
    profile.id
  ).filter((s) =>
    s.triggeredBy.some((n) => n.toLowerCase() === canonicalLower)
  );
  // A read-time DERIVED index (issue #40): its readings are computed from other
  // labs, not measured. Surface the formula so the value is transparent. Newest
  // derived reading carries the most representative substituted formula.
  const derivedReading = [...series].reverse().find((r) => r.derived);
  const starred = isBiomarkerSaved(profile.id, canonical);
  // Effective reference range and optimal band for the user's sex + age
  // (age band, then sex-specific override, else the generic band). Drive the chart
  // bands, the displayed ranges, and the badge. For an age-banded biomarker the
  // range shown reflects the subject's age on the LATEST reading's date (the
  // "age on the collection date, not today" rule); a series that crosses age bands
  // is labeled by that latest band.
  const sex = getUserSex(profile.id);
  const latestDate = series[series.length - 1]?.date ?? null;
  const age = getUserAgeOn(profile.id, latestDate);
  // For female physiology, an explicit reproductive status overrides the age proxy
  // when selecting the reproductive-hormone ranges.
  const reproductiveStatus = getUserReproductiveStatus(profile.id);
  const ref = referenceRange(cb, sex, age, reproductiveStatus);
  const opt = optimalBand(cb, sex, age);
  const bandLabel = ageBandLabel(ref.band);

  // Map each source document id to a human label (its lab/provider source, or
  // the doc type / filename as fallbacks) for the readings table.
  const docLabels = new Map<number, string>();
  const docIds = [
    ...new Set(
      series.map((r) => r.document_id).filter((x): x is number => x != null)
    ),
  ];
  for (const d of getMedicalDocumentsByIds(profile.id, docIds)) {
    docLabels.set(d.id, documentLabel(d));
  }

  // Correction lineage (#1404): the prior values a re-import overwrote, per reading.
  // A re-issued lab result no longer replaces what the user read with nothing to show
  // for it — the superseded value is preserved beside its reading (never among the
  // readings, so it can't chart, count, or flag) and surfaces here. Derived readings
  // carry synthetic negative ids and have no lineage; the helper filters them out.
  const revisionsByRecord = getRevisionsByRecord(
    profile.id,
    series.map((r) => r.id)
  );

  // Newest reading overall (series is oldest-first) for the header value.
  const latest = series[series.length - 1];

  // The live GOAL on this analyte (#1853), rendered beside the series it describes —
  // the join the issue is about. Progress comes from the SAME getOutcomeGoalProgressMap the
  // Training goal card reads, so the two surfaces cannot show different numbers for
  // one target; matching is by the #482 family, so a target set on any member shows
  // on the page that charts them.
  const todayStr = today(profile.id);
  const biomarkerGoals = getBiomarkerOutcomeGoals(profile.id, canonical);
  const goalProgress = getOutcomeGoalProgressMap(profile.id, biomarkerGoals);

  // "The rest of this panel" (#1502) — the shared gather, so this page and the
  // metric detail surface list the same siblings for the same panel (#1932).
  const panelSiblings = getPanelSiblings(profile.id, canonical);

  const cbHasRange =
    !!cb && [ref.low, ref.high, opt.low, opt.high].some((v) => v != null);

  // Readings we can place on the chart: exact (value_num), inexact-but-bounded ones
  // ("<0.10", ">5") plotted at their limit, and (issue #542) a leading numeric
  // recovered from a unit-suffixed or titer value ("58 mIU/mL" → 58, "1:160" → 160)
  // the extraction left in the value string. Each carries the source record + a
  // numeric plot value; bounded dots render hollow. The SAME plottableReadingValue
  // the badge derives from, so the chart and the status agree on what plots.
  const plottable = series.flatMap((r) => {
    const p = plottableReadingValue(r.value_num, r.value);
    return p ? [{ r, value: p.value, bound: p.bound }] : [];
  });
  // Newest reading we can place on the scale, exact or bounded — drives the
  // status badge as well as the fallback chart unit.
  const latestPlottable = plottable.length
    ? plottable[plottable.length - 1]
    : null;

  // Purely qualitative readings (nothing plottable) — a fully-qualitative series
  // (positive/reactive/negative/immune titers) renders as a dated timeline instead
  // of a blank numeric chart (issue #543). Presence/polarity come from the SAME
  // classifier the flag + staleness logic use (#549), so the chart never disagrees
  // with the status about what "positive" means for this analyte.
  const qualitativeReadings = series.flatMap((r) => {
    if (plottableReadingValue(r.value_num, r.value) != null) return [];
    const c = classifyQualitativeResult(
      canonical,
      r.value,
      r.notes,
      r.reference_range
    );
    return [{ r, polarity: c?.polarity ?? ("neutral" as const) }];
  });
  // Tone for a qualitative dot/chip by its classified polarity: good = emerald,
  // bad = rose, neutral = slate. Mirrors the flag tone tiers.
  const qualitativeTone: Record<"good" | "bad" | "neutral", string> = {
    good: "bg-emerald-500",
    bad: "bg-rose-500",
    neutral: "bg-slate-400",
  };

  // Charting unit + points + bands. When the biomarker has a canonical unit, we
  // chart in THAT unit, converting every reading we can (so mg/dL and mmol/L
  // results sit on one axis) and drawing the dataset's bands. Readings whose unit
  // can't be converted are dropped and noted. Without a canonical unit we fall
  // back to the latest reading's unit and the parsed lab reference range.
  let chartUnit: string | null;
  let chartPoints: { date: string; value: number; bound?: "<" | ">" }[];
  let otherUnits: string[];
  let bands: BiomarkerBands = {};

  if (cb && cb.unit) {
    chartUnit = cb.unit;
    const converted = plottable.map((x) => ({
      ...x,
      v: convertToCanonical(x.value, x.r.unit, cb),
    }));
    chartPoints = converted
      .filter((x) => x.v != null)
      .map((x) => ({ date: x.r.date, value: x.v as number, bound: x.bound }));
    otherUnits = [
      ...new Set(
        converted.filter((x) => x.v == null).map((x) => x.r.unit ?? "—")
      ),
    ];
    if (cbHasRange) {
      bands = {
        refLow: ref.low,
        refHigh: ref.high,
        optimalLow: opt.low,
        optimalHigh: opt.high,
      };
    }
  } else {
    chartUnit = latestPlottable?.r.unit ?? null;
    chartPoints = plottable
      .filter((x) => sameUnit(x.r.unit, chartUnit))
      .map((x) => ({ date: x.r.date, value: x.value, bound: x.bound }));
    otherUnits = [
      ...new Set(
        plottable
          .filter((x) => !sameUnit(x.r.unit, chartUnit))
          .map((x) => x.r.unit ?? "—")
      ),
    ];
    const parsed = parseReferenceRange(latest.reference_range);
    if (parsed)
      bands = { refLow: parsed.low ?? null, refHigh: parsed.high ?? null };
  }
  // Body Temperature series-view axis (#857): canonical storage is °F, but a °C login
  // sees the axis, plotted points, and reference bands in Celsius. Contained to the
  // chart — the reference-range CARDS below stay in the canonical unit. Only the chart
  // axis/data is transformed; the raw readings table shows each reading's stored unit.
  if (chartUnit === "degF" && temperatureUnit === "C") {
    chartUnit = tempUnitLabel("C");
    chartPoints = chartPoints.map((p) => ({
      ...p,
      value: degFTo(p.value, "C"),
    }));
    const bandC = (v: number | null | undefined) =>
      v == null ? v : degFTo(v, "C");
    bands = {
      refLow: bandC(bands.refLow),
      refHigh: bandC(bands.refHigh),
      optimalLow: bandC(bands.optimalLow),
      optimalHigh: bandC(bands.optimalHigh),
    };
  }
  const unchartedCount = plottable.length - chartPoints.length;
  const hasBounded = chartPoints.some((p) => p.bound);

  // Life-event annotations + the targeting protocol's intervention window for THIS
  // analyte (issue #660). The detail chart previously drew no markers, so a
  // med-start → LDL-drop had nowhere to read. Full history (open range) — the
  // chart's epoch axis clips anything outside the plotted extent; the client
  // BiomarkerTrendChart owns the per-type toggle. Protocol windows are narrowed to
  // the protocols that DECLARE this biomarker as an outcome (not every protocol).
  const openRange = { from: undefined, to: undefined };
  const chartAnnotations = buildTrendAnnotations(profile.id, openRange);
  const protocolWindows = buildProtocolWindows(
    getProtocolWindowsForOutcome(profile.id, `biomarker:${canonical}`),
    openRange
  );

  const refRange = cb ? formatRange(ref.low, ref.high, cb.unit) : null;
  const optimalRange = cb ? formatRange(opt.low, opt.high, cb.unit) : null;
  // Label a range with the qualifiers that shaped it: the reproductive status (when
  // a status range applied — female physiology), else the user's sex (when a
  // sex-specific override applied), and/or the age band (e.g. "age 6–12").
  const statusApplied =
    cb != null &&
    selectStatusRange(cb.ranges_by_status, sex, reproductiveStatus) != null;
  const qualify = (bySex: boolean, statusWord: string | null) =>
    [statusWord ?? (bySex && sex ? sex : null), bandLabel]
      .filter(Boolean)
      .join(", ");
  // The status range only shapes the REFERENCE range (the optimal band has no
  // status axis), so the status word qualifies the reference label only.
  const refQualifier = qualify(
    ref.bySex,
    statusApplied ? reproductiveStatus : null
  );
  const optQualifier = qualify(opt.bySex, null);
  const refLabel = refQualifier
    ? `Reference range (${refQualifier})`
    : "Reference range";
  const optimalLabel = optQualifier
    ? `Optimal range (${optQualifier})`
    : "Optimal range";

  // Range card(s). Normally one band — the generic band, or the user's sex when
  // the biomarker is sex-specific and their sex is known. But when the band
  // varies by sex and we DON'T know the user's sex, show both labeled by gender,
  // so the dependence is visible rather than silently dropped. Same logic for
  // both the reference range and the optimal band.
  const refField = (which: "male" | "female", bound: "low" | "high") =>
    cb?.[`ref_${bound}_${which}` as const] ?? null;
  const optField = (which: "male" | "female", bound: "low" | "high") =>
    cb?.[`optimal_${bound}_${which}` as const] ?? null;

  const referenceEntries: { label: string; range: string }[] = [];
  if (refRange) {
    referenceEntries.push({ label: refLabel, range: refRange });
  } else if (cb && !ref.band) {
    // Only when NO age band applied: show both sexes' adult ranges when sex is
    // unknown. An active band replaces the adult fields, so we must not resurrect
    // adult sex-specific ranges on a pediatric view.
    const male = formatRange(
      refField("male", "low"),
      refField("male", "high"),
      cb.unit
    );
    const female = formatRange(
      refField("female", "low"),
      refField("female", "high"),
      cb.unit
    );
    if (male)
      referenceEntries.push({ label: "Reference range (male)", range: male });
    if (female)
      referenceEntries.push({
        label: "Reference range (female)",
        range: female,
      });
  }

  const optimalEntries: { label: string; range: string }[] = [];
  if (optimalRange) {
    optimalEntries.push({ label: optimalLabel, range: optimalRange });
  } else if (cb && !opt.band) {
    // Only when NO age band applied (see reference range above): an active band
    // replaces the adult optimal fields, so don't fall back to the adult
    // sex-specific optimal band for a child (e.g. Ferritin's adult 100–300 male).
    const male = formatRange(
      optField("male", "low"),
      optField("male", "high"),
      cb.unit
    );
    const female = formatRange(
      optField("female", "low"),
      optField("female", "high"),
      cb.unit
    );
    if (male)
      optimalEntries.push({ label: "Optimal range (male)", range: male });
    if (female)
      optimalEntries.push({ label: "Optimal range (female)", range: female });
  }

  // WHAT THE PAGE CAN SHOW AS THE BASIS FOR A COLOUR (#2340). The entries above are
  // the app's OWN bands; when both lists are empty — guaranteed for an analyte the
  // catalog deliberately declines to band — the flag's only visible basis is the range
  // the source document printed on the row itself, which this surface never consulted.
  // `biomarkerValueBasis` decides, per reading, which basis exists and therefore
  // whether the value may be coloured at all: a reading with none renders neutral,
  // its caret and its severity word included, because the suppression happens at the
  // flag rather than at the colour (see the module header for why those travel
  // together, and what it means for #2343's visible severity label below).
  const hasCuratedBand =
    referenceEntries.length > 0 || optimalEntries.length > 0;
  const basisFor = (r: MedicalRecord) =>
    biomarkerValueBasis({
      flag: r.flag,
      hasCuratedBand,
      reportedRange: r.reference_range,
      // The SAME classifier the qualitative timeline reads and the stored flag was
      // resolved against, so "the value states its own verdict" cannot mean one thing
      // to the flag and another to the basis.
      qualitative:
        classifyQualitativeResult(
          canonical,
          r.value,
          r.notes,
          r.reference_range,
          r.loinc
        ) != null,
    });
  const latestBasis = basisFor(latest);
  // WHY there is no band, taken from the curated note and rendered where the band is
  // missing instead of in the page subtitle (#2340 part 2). Only when the page shows
  // no curated band — that is the question it answers.
  const bandNote = hasCuratedBand ? null : bandNoteClause(cb?.note);

  // Judge the latest reading in the canonical unit: out of range, non-optimal,
  // or optimal. Bounded readings ("<0.10") are judged at their limit, like the
  // chart plots them.
  const badge = rangeBadge(
    latestPlottable
      ? convertToCanonical(latestPlottable.value, latestPlottable.r.unit, cb)
      : null,
    cb,
    sex,
    age,
    reproductiveStatus
  );
  const badgeMeta = RANGE_BADGE_META[badge];

  // Age/sex percentile + fitness age for the longevity fitness markers (VO2 Max,
  // grip strength, chair stand, balance) — issue #158. Uses the latest reading in
  // the canonical unit and the subject's sex + age-on-that-reading. Renders nothing
  // (fitnessContextFor → null) for a non-fitness marker or when sex/age is unset.
  const latestCanonicalValue = latestPlottable
    ? convertToCanonical(latestPlottable.value, latestPlottable.r.unit, cb)
    : null;
  const fitnessCtx = fitnessContextFor(
    canonical,
    latestCanonicalValue,
    sex,
    age
  );

  // Staleness: most biomarkers want a yearly retest; genomics never go stale, and an
  // immune-positive durable-immunity titer (hep A/B surface Ab, MMR/varicella IgG)
  // never goes stale either (#516).
  const stale = isBiomarkerStale(
    latest.date,
    latest.category,
    today(profile.id),
    undefined,
    {
      name: canonical || latest.name,
      flag: latest.flag,
      value: latest.value,
      notes: latest.notes,
      reference: latest.reference_range,
      loinc: latest.loinc,
    }
  );
  const ageDays = daysBetween(latest.date, today(profile.id));

  // Flagged-lab follow-up chain (issue #700 labs adapter), all keyed on THIS
  // biomarker's #482 FAMILY (an A1c follow-up shows on the eAG page too, and
  // vice-versa). Priority:
  //   - an OPEN "Recheck …" follow-up → show its state (recheck due);
  //   - else, when the latest reading is OUT OF RANGE (a real stored reading, not a
  //     computed/derived index) → offer to track one — so a NEW flag can start a NEW
  //     follow-up even after an earlier one resolved;
  //   - else, a recently RESOLVED follow-up → show its recorded outcome.
  // An intraocular-pressure biomarker routes to the IOP glaucoma-workup adapter (#698
  // §6): its own source_kind='iop', its own "Recheck IOP / glaucoma workup" copy, and
  // ONE bilateral question (any eye maps to the same follow-up) — so it does NOT filter
  // by biomarker family (IOP is deliberately not a global family; see lib/followup-iop).
  // Every other biomarker uses the generic labs adapter, keyed on this biomarker's #482
  // family (an A1c follow-up shows on the eAG page too, and vice-versa). Priority:
  //   - an OPEN "Recheck …" follow-up → show its state (recheck due);
  //   - else, when the latest reading is OUT OF RANGE (a real stored reading, not a
  //     computed/derived index) → offer to track one — so a NEW flag can start a NEW
  //     follow-up even after an earlier one resolved;
  //   - else, a recently RESOLVED follow-up → show its recorded outcome.
  const isIop = isIopBiomarker(canonical);
  const famKey = biomarkerFamily(canonical).toLowerCase();
  const familyFollowUps = isIop
    ? getIopFollowUps(profile.id)
    : getLabFollowUps(profile.id).filter(
        (f) => biomarkerFamily(f.sourceName).toLowerCase() === famKey
      );
  const openLabFollowUp = familyFollowUps.find(
    (f) => f.resolution == null && f.status !== "completed"
  );
  const resolvedLabFollowUp = familyFollowUps.find(
    (f) => f.resolution != null || f.status === "completed"
  );
  const canTrackFollowUp =
    !latest.derived &&
    typeof latest.id === "number" &&
    latest.id > 0 &&
    isOutOfRange(latest.flag);
  // The summary to render: the open one wins; else the track form (when flagged); else
  // the resolved outcome. undefined ⇒ the control renders its "Track follow-up" form.
  const existingFollowUp =
    openLabFollowUp ?? (canTrackFollowUp ? undefined : resolvedLabFollowUp);
  const showFollowUpControl =
    openLabFollowUp != null || canTrackFollowUp || resolvedLabFollowUp != null;

  // #2347 — both care offers on this page name their own basis. `canTrackFollowUp`
  // above and `isBiomarkerStale` further up are UNCHANGED (no offer appears or
  // disappears here); what changes is what each one says for itself once #2340 has
  // decided the value renders without a judgment. See lib/biomarker-care-basis.ts for
  // the ruling, the two copy rules, and why the retest half is a different sentence.
  const recheckBasis = careOfferBasis("recheck", {
    basis: latestBasis.kind,
    flag: latest.flag,
  });
  const retestBasis = careOfferBasis("retest", {
    basis: latestBasis.kind,
    flag: latest.flag,
  });

  return (
    <div>
      <Link
        href="/results/biomarkers"
        className="mb-4 inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"
      >
        <IconArrowLeft className="h-4 w-4" /> Back to biomarkers
      </Link>

      {/* One prose surface per fact (#2340). The subtitle used to append the curated
          `note`, which for at least one analyte is a near-paraphrase of the explainer
          card's `description` fifteen lines below — the same fact twice, in different
          words. The card keeps the description; the note's band clause moves to the
          summary card, beside the band it explains the absence of. */}
      <PageHeader
        title={canonical}
        subtitle={`${series.length} reading${series.length === 1 ? "" : "s"}`}
        action={
          <StarButton
            itemKey={bioSeriesKey(canonical)}
            saved={starred}
            label={canonical}
          />
        }
      />

      {derivedReading && (
        <Notice tone="slate" testid="derived-note" className="mb-6">
          <span className="font-semibold">Derived index.</span> These values are
          computed from your other lab readings on the same draw date, not
          measured directly.{" "}
          <span className="font-medium">{derivedReading.derived_formula}</span>.
        </Notice>
      )}

      {stale && (
        <Notice tone="amber" className="mb-6">
          <span className="font-semibold">These results are stale.</span> The
          most recent reading is from {latest.date} ({humanizeAge(ageDays)}{" "}
          ago). Most biomarkers should be retested at least once a year —{" "}
          <Link href="/data" className="font-medium underline">
            upload your latest records
          </Link>{" "}
          or get new tests to keep this trend current.
          {/* The notice names its own premise (#2347). It always printed the date and
              the age it is reasoning from; what it needed is the one distinction #2340
              made newly confusing — on a page that has deliberately declined to judge
              the number, an amber banner beside it reads like a verdict on the value.
              Rendered only where that is the case. */}
          {retestBasis.note && (
            <>
              {" "}
              <span data-testid="biomarker-retest-basis">
                {retestBasis.note}
              </span>
            </>
          )}
        </Notice>
      )}

      {/* Educational explainer: what this biomarker is and why it generally
          matters. Rendered only when a curated description exists; graceful when
          absent. Informational, not personal interpretation. This is the page's ONE
          prose surface for that fact (#2340) — the subtitle no longer paraphrases it
          out of the curated `note`. */}
      {info && (
        <div
          data-testid="biomarker-explainer"
          className="card mb-6 border-l-4 border-l-brand-300 dark:border-l-brand-700"
        >
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {info.full_name}
            {info.abbreviation && info.abbreviation !== info.full_name && (
              <span className="ml-2 font-normal text-slate-500 dark:text-slate-400">
                {info.abbreviation}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-300">
            {info.description}
          </p>
        </div>
      )}

      {/* Summary header: latest value, ranges, optimal status. */}
      <div className="card mb-6 flex flex-wrap items-center gap-x-8 gap-y-3">
        <div>
          <div className="label">Latest</div>
          <div
            className="text-2xl font-bold text-slate-900 dark:text-slate-100"
            data-testid="biomarker-latest-value"
            data-basis={latestBasis.kind}
          >
            {/* Coloured only against a basis the page can show (#2340). */}
            <MedicalValue
              value={latest.value}
              unit={latest.unit}
              flag={latestBasis.displayFlag}
            />
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            as of {latest.date}
          </div>
        </div>
        {referenceEntries.map((e) => (
          <div key={e.label}>
            <div className="label">{e.label}</div>
            <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
              {e.range}
            </div>
          </div>
        ))}
        {/* The source document's OWN printed range, when the catalog publishes none
            (#2340). Attributed, because it is the lab's band for that draw and not a
            population band the app endorses — two readings of one such analyte can
            carry different ones. */}
        {latestBasis.reportedEntry && (
          <div data-testid="biomarker-reported-range">
            <div className="label">{latestBasis.reportedEntry.label}</div>
            <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
              {latestBasis.reportedEntry.range}
            </div>
          </div>
        )}
        {optimalEntries.map((e) => (
          <div key={e.label}>
            <div className="label">{e.label}</div>
            <div className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
              {e.range}
            </div>
          </div>
        ))}
        {biomarkerGoals.map((goal) => {
          const progress = goalProgress.get(goal.id);
          const pct = goalPct(goal, progress);
          return (
            <div key={goal.id} data-testid="biomarker-goal">
              <div className="label">Goal</div>
              <div className="text-sm font-medium text-brand-700 dark:text-brand-400">
                {biomarkerGoalTargetText(goal)}
                {goal.target_date ? ` by ${goal.target_date}` : ""}
              </div>
              <div
                className="text-xs text-slate-500 dark:text-slate-400"
                data-tone={
                  pct == null
                    ? undefined
                    : goalPaceTone(pct, {
                        createdAt: goal.created_at,
                        targetDate: goal.target_date,
                        today: todayStr,
                        // Per-RESULT pacing: the verdict is frozen at the last draw,
                        // because nothing about a lab goal changes on a day no lab
                        // was drawn (#1853).
                        evidenceDate: progress?.asOf ?? null,
                      })
                }
              >
                {biomarkerGoalCurrentText(progress)}
                {progress?.checkIn
                  ? ` · ${biomarkerGoalCheckInText(progress.checkIn, (d) => d)}`
                  : ""}
              </div>
            </div>
          );
        })}
        {badge !== "unknown" && latest.flag !== "immune" && (
          <div>
            <div className="label">Status</div>
            <span className={`badge ${badgeMeta.chip}`}>{badgeMeta.label}</span>
          </div>
        )}
        {/* A GOOD durable-immunity titer resolves to a neutral "Immune" status, never
            a red "Abnormal" (#544/#549) — the flag reconcile stores it as "immune". */}
        {latest.flag === "immune" && (
          <div data-testid="immune-status">
            <div className="label">Status</div>
            <span className="badge bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
              Immune
            </span>
          </div>
        )}
        {/* Finding follow-up (#700 labs adapter): a flagged result can be tracked to a
            "Recheck …" follow-up on Upcoming (or shows an open one's state). */}
        {showFollowUpControl && (
          <div data-testid="lab-followup">
            <div className="label">Recheck</div>
            <TrackLabFollowUpControl
              recordId={typeof latest.id === "number" ? latest.id : 0}
              existing={existingFollowUp}
              kind={isIop ? "iop" : "lab"}
            />
          </div>
        )}
        {/* Why the offer above is there (#2347). Only when the page shows no judgment
            of the value AND the control on screen is the OFFER — the two conditions
            together are exactly "the track form is rendering", since an existing
            follow-up stands on somebody having tracked one, which is its own premise
            and needs no explaining, and `canTrackFollowUp` also refuses a derived or
            unsaved reading. `basis-full` so it reads as prose under the value row,
            like the band note below it. */}
        {showFollowUpControl &&
          existingFollowUp === undefined &&
          recheckBasis.note && (
            <p
              data-testid="biomarker-recheck-basis"
              className="basis-full text-sm leading-relaxed text-slate-600 dark:text-slate-300"
            >
              <span className="font-semibold text-slate-800 dark:text-slate-100">
                {RECHECK_BASIS_HEADING}
              </span>{" "}
              {recheckBasis.note}
            </p>
          )}
        {/* Why this analyte has no band (#2340), from the curated note — the one
            clause the explainer card's description does not carry, rendered where the
            reader asks the question it answers rather than in a header subtitle.
            `basis-full` so it reads as prose under the value row, not as a chip. */}
        {bandNote && (
          <p
            data-testid="biomarker-band-note"
            className="basis-full text-sm leading-relaxed text-slate-600 dark:text-slate-300"
          >
            <span className="font-semibold text-slate-800 dark:text-slate-100">
              No reference band.
            </span>{" "}
            {bandNote}
          </p>
        )}
      </div>

      {/* "The rest of this panel" (#1502). A single-analyte page used to be a dead
          end: you could see your LDL, but nothing told you it arrived with an HDL
          and a triglycerides, or offered a way across. Hidden for an analyte the
          taxonomy can't place, and when nothing else in the panel has been
          measured. */}
      {panelSiblings && (
        <PanelSiblingsCard
          panelId={panelSiblings.panelId}
          names={panelSiblings.names}
        />
      )}

      {/* Cross-link to the immunization/immunity surface (#544 part 2): the value
          lives here, the schedule meaning lives there — a user on either wants the
          other. Shown only for a durable-immunity titer analyte. */}
      {isDurableImmunityTiter(canonical) && (
        <div
          data-testid="immunity-crosslink"
          className="card mb-6 flex items-center justify-between gap-3 border-l-4 border-l-emerald-300 text-sm dark:border-l-emerald-700"
        >
          <span className="text-slate-700 dark:text-slate-200">
            <span className="font-semibold">Immunity marker.</span> This titer
            backs your immunization record.
          </span>
          <Link
            href="/records/history/immunizations"
            className="shrink-0 font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            See immunity status →
          </Link>
        </div>
      )}

      {/* Deterministic food suggestions (#577/#775): food-first, safety-screened
          guidance when this diet-responsive biomarker reads low (eat more) OR high (cut
          back on limit-tier foods). Informational, not medical advice; hidden when
          nothing applies. Heading/accent follow the direction actually present. */}
      {foodSuggestions.length > 0 &&
        (() => {
          const onlyReduce = foodSuggestions.every(
            (s) => s.direction === "reduce"
          );
          return (
            <div
              data-testid="biomarker-food-suggestions"
              className={
                onlyReduce
                  ? "card mb-6 border-l-4 border-l-amber-300 dark:border-l-amber-700"
                  : "card mb-6 border-l-4 border-l-emerald-300 dark:border-l-emerald-700"
              }
            >
              <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
                {onlyReduce ? "Foods to cut back" : "Food sources"}
              </h2>
              <FoodSuggestions suggestions={foodSuggestions} />
            </div>
          );
        })()}

      {/* Curated supplement options for this flagged biomarker (#2378). A separate card
          from the food one: eating a food and swallowing a capsule are different acts,
          and the card says which claim this is. */}
      {curatedSupplementSuggestions.length > 0 && (
        <div
          data-testid="biomarker-supplement-suggestions"
          className="card mb-6 border-l-4 border-l-emerald-300 dark:border-l-emerald-700"
        >
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Supplement options
          </h2>
          <CuratedSupplementSuggestions
            suggestions={curatedSupplementSuggestions}
          />
        </div>
      )}

      {/* Age/sex percentile + fitness age (#158) — fitness markers only, hidden
          when sex/age unset. */}
      <FitnessPercentileCard ctx={fitnessCtx} />

      {/* Chart */}
      <div className="card mb-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Trend
          </h2>
          {chartUnit ? (
            <span className="text-xs text-slate-500 dark:text-slate-400">
              in {chartUnit}
            </span>
          ) : null}
        </div>
        {chartPoints.length === 0 ? (
          qualitativeReadings.length > 0 ? (
            // A qualitative series has no numeric axis — show the results as a dated
            // timeline (newest first) so the history is legible instead of blank (#543).
            <ol
              data-testid="qualitative-timeline"
              className="space-y-2 text-sm"
            >
              {[...qualitativeReadings].reverse().map(({ r, polarity }) => (
                <li
                  key={r.id}
                  className="flex items-center gap-3 rounded-md border border-black/5 px-3 py-2 dark:border-white/10"
                >
                  <span
                    className={`h-2.5 w-2.5 shrink-0 rounded-full ${qualitativeTone[polarity]}`}
                    aria-hidden
                  />
                  <span className="w-24 shrink-0 text-slate-500 dark:text-slate-400">
                    {r.date}
                  </span>
                  <span className="font-medium text-slate-800 dark:text-slate-100">
                    {r.value ?? "—"}
                  </span>
                </li>
              ))}
            </ol>
          ) : (
            <EmptyState message="No numeric readings to chart (qualitative biomarker)." />
          )
        ) : (
          <BiomarkerTrendChart
            data={chartPoints}
            unit={chartUnit ?? ""}
            bands={bands}
            annotations={chartAnnotations}
            windows={protocolWindows}
          />
        )}
        {unchartedCount > 0 && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            {unchartedCount} reading(s) in non-convertible units (
            {otherUnits.join(", ")}) not charted.
          </p>
        )}
        {hasBounded && (
          <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
            Hollow points are bounded results (e.g. “&lt;0.10”), plotted at the
            limit — the true value lies beyond it.
          </p>
        )}
        <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
          Reference and optimal ranges may be inaccurate and often vary by sex
          and age. Consult a clinician.
        </p>
      </div>

      {/* Readings table (newest first). */}
      <div className="card overflow-hidden p-0">
        <h2 className="px-5 pt-5 font-semibold text-slate-800 dark:text-slate-100">
          Readings
        </h2>
        <ScrollFade className="mt-3">
          <table className="w-full whitespace-nowrap">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/10">
                <th className="th">Date</th>
                <th className="th">Value</th>
                <th className="th">Lab reference</th>
                <th className="th">Source</th>
                <th className="th">Reported as</th>
              </tr>
            </thead>
            <tbody>
              {[...series].reverse().map((r) => {
                const basis = basisFor(r);
                return (
                  <tr
                    key={r.id}
                    className="border-b border-black/5 dark:border-white/10"
                  >
                    <td className="td whitespace-nowrap">{r.date}</td>
                    <td className="td" data-basis={basis.kind}>
                      {/* The severity word visibly, not only in the accessibility
                        tree (#1220/#2315): this list intermixes out-of-range and
                        above-optimal readings of the same analyte, so red-vs-amber
                        alone was the only channel separating them for a sighted
                        reader. The bands themselves are the cards above — this
                        column is the LAB's stated range, provenance for each row.
                        Every row goes through the same basis decision as the value
                        above it (#2340): with no curated band AND no printed range in
                        the neighbouring cell, a visible "Low" would be the louder
                        version of exactly the unsupported claim this closes, so the
                        row goes neutral — colour, caret and word together. */}
                      <MedicalValue
                        value={r.value}
                        unit={r.unit}
                        flag={basis.displayFlag}
                        showFlagLabel
                      />
                      {/* How this result was collected and where it sits in the lab
                        lifecycle (#1404) — shown only when the source said. */}
                      {readingAttributes(r).length > 0 && (
                        <div
                          className="text-xs text-slate-500 dark:text-slate-400"
                          data-testid="reading-attributes"
                        >
                          {readingAttributes(r).join(" · ")}
                        </div>
                      )}
                      {(revisionsByRecord.get(r.id) ?? []).map((rev) => (
                        <div
                          key={rev.id}
                          className="text-xs text-amber-700 dark:text-amber-400"
                          data-testid="reading-revision"
                        >
                          {revisionSummary(rev)}
                        </div>
                      ))}
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {r.reference_range ?? "—"}
                    </td>
                    <td className="td">
                      {r.derived ? (
                        <span
                          className="text-slate-500 dark:text-slate-400"
                          title={r.derived_formula}
                        >
                          Computed
                        </span>
                      ) : r.document_id ? (
                        <Link
                          href={`/import/${r.document_id}`}
                          className="text-brand-700 hover:underline dark:text-brand-400"
                        >
                          {docLabels.get(r.document_id) ?? "Document"}
                        </Link>
                      ) : (
                        <span className="text-slate-500 dark:text-slate-400">
                          Manual entry
                        </span>
                      )}
                    </td>
                    <td className="td text-slate-500 dark:text-slate-400">
                      {r.name}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollFade>
      </div>
    </div>
  );
}
