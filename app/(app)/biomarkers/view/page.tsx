import Link from "next/link";
import { IconArrowLeft } from "@tabler/icons-react";
import {
  documentLabel,
  getBiomarkerSeriesWithDerived,
  getCanonicalBiomarker,
  getMedicalDocumentsByIds,
  getFoodSuggestions,
  isBiomarkerStarred,
} from "@/lib/queries";
import FoodSuggestions from "@/components/FoodSuggestions";
import type { CanonicalBiomarker, Sex } from "@/lib/types";
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
  daysBetween,
  humanizeAge,
} from "@/lib/reference-range";
import { convertToCanonical, sameUnit } from "@/lib/unit-conversions";
import { getBiomarkerInfo } from "@/lib/biomarker-info";
import {
  getUserAgeOn,
  getUserBirthdate,
  getUserReproductiveStatus,
  getUserSex,
} from "@/lib/settings";
import { getLatestMetricSample } from "@/lib/queries";
import { ageInMonthsFromBirthdate } from "@/lib/date";
import { measurementPercentile } from "@/lib/growth";
import {
  bpComponentFor,
  pediatricBpContext,
  type PediatricBpContext,
} from "@/lib/bp-percentiles";
import { PediatricBpCard } from "@/components/PediatricBpCard";
import { today } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { PageHeader, EmptyState, MedicalValue } from "@/components/ui";
import BiomarkerChart, {
  type BiomarkerBands,
} from "@/components/BiomarkerChart";
import StarButton from "@/components/StarButton";
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

// The profile's latest height as a growth-chart percentile (WHO/CDC LMS), for the
// pediatric BP interpretation (#150). Null when sex/height/birthdate is missing —
// pediatricBpContext then assumes the 50th height percentile.
function latestHeightPercentile(
  profileId: number,
  sex: Sex | null
): number | null {
  if (sex !== "male" && sex !== "female") return null;
  const h = getLatestMetricSample(profileId, "height_cm");
  if (!h) return null;
  const birthdate = getUserBirthdate(profileId);
  const months = birthdate ? ageInMonthsFromBirthdate(birthdate, h.date) : null;
  if (months == null) return null;
  return (
    measurementPercentile(sex, months, "height", h.value)?.percentile ?? null
  );
}

export default async function BiomarkerDetailPage(props: {
  searchParams: Promise<{ name?: string }>;
}) {
  const searchParams = await props.searchParams;
  const { profile } = await requireSession();
  const canonical = searchParams.name?.trim();
  const series = canonical
    ? getBiomarkerSeriesWithDerived(profile.id, canonical)
    : [];

  if (!canonical || series.length === 0) {
    return (
      <div>
        <Link
          href="/biomarkers"
          className="mb-4 inline-flex items-center gap-1 text-sm text-brand-700 hover:underline dark:text-brand-400"
        >
          <IconArrowLeft className="h-4 w-4" /> Back to biomarkers
        </Link>
        <PageHeader title={canonical || "Biomarker"} />
        <EmptyState
          message={
            canonical
              ? `No readings found for “${canonical}”.`
              : "No biomarker selected."
          }
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
  // A read-time DERIVED index (issue #40): its readings are computed from other
  // labs, not measured. Surface the formula so the value is transparent. Newest
  // derived reading carries the most representative substituted formula.
  const derivedReading = [...series].reverse().find((r) => r.derived);
  const starred = isBiomarkerStarred(profile.id, canonical);
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

  // Newest reading overall (series is oldest-first) for the header value.
  const latest = series[series.length - 1];

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

  // Pediatric BP interpretation (#150): for a CHILD, a blood-pressure reading is
  // judged by the AAP 2017 age/sex/height percentile, not the adult thresholds
  // (which mis-classify children). When it applies we render the percentile +
  // category card and SUPPRESS the adult reference range, optimal band, status
  // badge, and chart bands. Null (→ adult behavior) for any non-BP marker or adult.
  const bpComponent = bpComponentFor(canonical);
  let bpCtx: PediatricBpContext | null = null;
  if (bpComponent && latestPlottable) {
    bpCtx = pediatricBpContext(
      bpComponent,
      convertToCanonical(latestPlottable.value, latestPlottable.r.unit, cb),
      {
        sex,
        ageYears: age,
        heightPercentile: latestHeightPercentile(profile.id, sex),
      }
    );
  }
  const pediatricBp = bpCtx != null;

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
    if (cbHasRange && !pediatricBp) {
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
  const unchartedCount = plottable.length - chartPoints.length;
  const hasBounded = chartPoints.some((p) => p.bound);

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
    }
  );
  const ageDays = daysBetween(latest.date, today(profile.id));

  return (
    <div>
      <Link
        href="/biomarkers"
        className="mb-4 inline-flex items-center gap-1 text-sm text-brand-700 hover:underline"
      >
        <IconArrowLeft className="h-4 w-4" /> Back to biomarkers
      </Link>

      <PageHeader
        title={canonical}
        subtitle={`${series.length} reading${series.length === 1 ? "" : "s"}${
          cb?.note ? ` · ${cb.note}` : ""
        }`}
        action={<StarButton canonicalName={canonical} starred={starred} />}
      />

      {derivedReading && (
        <div
          data-testid="derived-note"
          className="mb-6 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300"
        >
          <span className="font-semibold">Derived index.</span> These values are
          computed from your other lab readings on the same draw date, not
          measured directly.{" "}
          <span className="font-medium">{derivedReading.derived_formula}</span>.
          Informational, not a diagnosis.
        </div>
      )}

      {stale && (
        <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          <span className="font-semibold">These results are stale.</span> The
          most recent reading is from {latest.date} ({humanizeAge(ageDays)}{" "}
          ago). Most biomarkers should be retested at least once a year —{" "}
          <Link href="/data" className="font-medium underline">
            upload your latest records
          </Link>{" "}
          or get new tests to keep this trend current.
        </div>
      )}

      {/* Educational explainer: what this biomarker is and why it generally
          matters. Rendered only when a curated description exists; graceful when
          absent. Informational, not personal interpretation. */}
      {info && (
        <div className="card mb-6 border-l-4 border-l-brand-300 dark:border-l-brand-700">
          <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">
            {info.full_name}
            {info.abbreviation && info.abbreviation !== info.full_name && (
              <span className="ml-2 font-normal text-slate-400 dark:text-slate-500">
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
          <div className="text-2xl font-bold text-slate-900 dark:text-slate-100">
            <MedicalValue
              value={latest.value}
              unit={latest.unit}
              flag={latest.flag}
            />
          </div>
          <div className="text-xs text-slate-400 dark:text-slate-500">
            as of {latest.date}
          </div>
        </div>
        {!pediatricBp &&
          referenceEntries.map((e) => (
            <div key={e.label}>
              <div className="label">{e.label}</div>
              <div className="text-sm font-medium text-slate-700 dark:text-slate-200">
                {e.range}
              </div>
            </div>
          ))}
        {!pediatricBp &&
          optimalEntries.map((e) => (
            <div key={e.label}>
              <div className="label">{e.label}</div>
              <div className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
                {e.range}
              </div>
            </div>
          ))}
        {!pediatricBp && badge !== "unknown" && latest.flag !== "immune" && (
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
      </div>

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
            href="/immunizations"
            className="shrink-0 font-medium text-brand-700 hover:underline dark:text-brand-400"
          >
            See immunity status →
          </Link>
        </div>
      )}

      {/* Deterministic food suggestions (#577): food-first, safety-screened guidance
          when this diet-responsive biomarker reads low. Informational, not medical
          advice; hidden when nothing applies. */}
      {foodSuggestions.length > 0 && (
        <div
          data-testid="biomarker-food-suggestions"
          className="card mb-6 border-l-4 border-l-emerald-300 dark:border-l-emerald-700"
        >
          <h2 className="mb-3 font-semibold text-slate-800 dark:text-slate-100">
            Food sources
          </h2>
          <FoodSuggestions suggestions={foodSuggestions} />
        </div>
      )}

      {/* Pediatric BP percentile + AAP category (#150) — child BP readings only,
          shown INSTEAD OF the adult thresholds; hidden for adults/non-BP markers. */}
      <PediatricBpCard ctx={bpCtx} />

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
            <span className="text-xs text-slate-400 dark:text-slate-500">
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
                  <span className="w-24 shrink-0 text-slate-400 dark:text-slate-500">
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
          <BiomarkerChart
            data={chartPoints}
            unit={chartUnit ?? ""}
            bands={bands}
          />
        )}
        {unchartedCount > 0 && (
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
            {unchartedCount} reading(s) in non-convertible units (
            {otherUnits.join(", ")}) not charted.
          </p>
        )}
        {hasBounded && (
          <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
            Hollow points are bounded results (e.g. “&lt;0.10”), plotted at the
            limit — the true value lies beyond it.
          </p>
        )}
        <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
          Reference and optimal ranges are informational, not medical advice.
          They may be inaccurate and often vary by sex and age. Consult a
          clinician.
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
              {[...series].reverse().map((r) => (
                <tr
                  key={r.id}
                  className="border-b border-black/5 dark:border-white/10"
                >
                  <td className="td whitespace-nowrap">{r.date}</td>
                  <td className="td">
                    <MedicalValue value={r.value} unit={r.unit} flag={r.flag} />
                  </td>
                  <td className="td text-slate-500 dark:text-slate-400">
                    {r.reference_range ?? "—"}
                  </td>
                  <td className="td">
                    {r.derived ? (
                      <span
                        className="text-slate-400 dark:text-slate-500"
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
                      <span className="text-slate-400 dark:text-slate-500">
                        Manual entry
                      </span>
                    )}
                  </td>
                  <td className="td text-slate-500 dark:text-slate-400">
                    {r.name}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollFade>
      </div>
    </div>
  );
}
