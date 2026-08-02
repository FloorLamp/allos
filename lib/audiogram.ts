// The AUDIOGRAM domain — pure (no DB, no network). Issue #1600.
//
// ── THE STORE DECISION (issue #1600 ask 1, per the #860/#944 observation rule) ──
//
// An audiogram is dated per-subject readings: a pure-tone air-conduction threshold in
// dB HL, per EAR, per test FREQUENCY. That is observation-shaped, so AGENTS.md's
// "Observation-shaped data" rule applies and the answer is REUSE, not a new table.
// The store is `medical_records` — category `vitals`, one row per (ear, frequency),
// under the canonical analyte names the repo ALREADY ships:
//
//     "Hearing Threshold, Right Ear 4 kHz"   value_num 40   unit "dB HL"
//
// Twelve of these (2 ears × 6 frequencies) are already curated in
// lib/canonical-biomarkers.json with unit `dB HL`, `ref_high: 25` (the WHO/ASHA normal
// band) and `direction: lower_better`; lib/biomarker-panels.ts already groups them as
// the `hearing` panel; lib/canonical-name.ts already argues (at length, #713) why each
// ear/frequency keeps its OWN singleton identity rather than collapsing into a
// biomarker FAMILY — collapsing would let a normal 1 kHz reading mark a flagged 4 kHz
// reading "current/OK" and would dedup two same-value ears on one date down to one row.
// So the vocabulary, the reference band, the flagging, the trend series, and the
// biomarker-catalog home were all decided by #713 and shipped. What #1600 found missing
// was never a STORE — it was an ENTRY SURFACE, and a reader for the ototoxic crosscheck.
//
// A NEW TABLE (`audiograms` + `audiogram_thresholds`) was considered and REJECTED — it
// does not clear the #944 bar:
//   • it would be a parallel store for a VOCABULARY EXTENSION, the exact thing the rule
//     names. Nothing about an audiogram needs a column `medical_records` lacks: date,
//     numeric value, unit, reference range, flag, notes, provenance (document_id /
//     external_id / provider_id), and the edit lock are all already there.
//   • it would STRAND the readings. Every observation surface in this app — the
//     Biomarkers catalog, the trend series, the flagged hero, star/retest side-state,
//     document reassignment, imported-row cleanup, undo-delete, search projections —
//     reads `medical_records`. A private table would have to re-earn every one of them,
//     and #713's readings (already seeded and already trending) would split in two.
//   • the ONE thing a dedicated table would buy — "an audiogram is a SESSION, not 12
//     loose readings" — is recoverable for free by grouping the readings on `date`
//     (groupAudiogramReadings, below), which is how the entry surface renders them.
// So: REUSE, and NO MIGRATION. The compact-structured-record option the issue floated
// (one row holding a JSON threshold blob) was rejected for the same stranding reason:
// a blob does not trend, does not flag, and is not searchable.
//
// ── THE SHARED SUBSTRATE (AGENTS.md "Observation-shaped data") ─────────────────
// The identity function this domain contributes is `audiogramSeriesKey` (ear +
// frequency), and it is what `latestByGroup` (lib/latest-per-group.ts) partitions on
// wherever "which threshold is current" is asked — see currentThresholds() below, the
// one place that question is answered. The edit-lock (`isEditLocked`) and the
// inserted/updated/unchanged accounting (`classifyUpsert`/`tallyUpsert`) belong to the
// WRITE path and live in the impure core (lib/audiogram-records.ts).

import { latestByGroup, type LatestRow } from "./latest-per-group";

// ---- Vocabulary -------------------------------------------------------------

export const AUDIOGRAM_EARS = ["right", "left"] as const;
export type AudiogramEar = (typeof AUDIOGRAM_EARS)[number];

// The six standard pure-tone air-conduction test frequencies, low → high. This is
// exactly the set lib/canonical-biomarkers.json curates for the `hearing` panel; the
// ORDER is load-bearing (the "adjacent frequencies" shift criterion below walks it).
export const AUDIOGRAM_FREQUENCIES_HZ = [
  250, 500, 1000, 2000, 4000, 8000,
] as const;
export type AudiogramFrequencyHz = (typeof AUDIOGRAM_FREQUENCIES_HZ)[number];

// The frequencies averaged into the pure-tone average (PTA). The four-frequency PTA
// (500/1k/2k/4k) is used rather than the classic three-frequency one because 4 kHz is
// where noise and ototoxic damage show up first — leaving it out would average away
// the very thing this domain exists to see.
export const PTA_FREQUENCIES_HZ = [500, 1000, 2000, 4000] as const;

export function isAudiogramEar(v: unknown): v is AudiogramEar {
  return AUDIOGRAM_EARS.includes(v as AudiogramEar);
}

export function isAudiogramFrequency(v: unknown): v is AudiogramFrequencyHz {
  return AUDIOGRAM_FREQUENCIES_HZ.includes(v as AudiogramFrequencyHz);
}

// "250 Hz" … "1 kHz" — the spelling the canonical analyte names use.
export function frequencyLabel(hz: number): string {
  return hz >= 1000 ? `${hz / 1000} kHz` : `${hz} Hz`;
}

// "Right Ear" / "Left Ear" — the spelling inside the canonical analyte name.
export function earCanonicalLabel(ear: AudiogramEar): string {
  return ear === "right" ? "Right Ear" : "Left Ear";
}

// "right ear" / "left ear" — for prose (the ototoxic note, list captions).
export function earLabel(ear: AudiogramEar): string {
  return ear === "right" ? "right ear" : "left ear";
}

// The canonical_name one (ear, frequency) threshold is stored under. The SINGLE
// place the analyte spelling is produced, so the write core, the SQL preimage, the
// dataset entries, and the seed can never disagree.
export function audiogramAnalyteName(
  ear: AudiogramEar,
  hz: AudiogramFrequencyHz
): string {
  return `Hearing Threshold, ${earCanonicalLabel(ear)} ${frequencyLabel(hz)}`;
}

// All twelve canonical analyte names, right ear then left, low → high frequency.
// The finite preimage the SQL reader needs (#394 — SQL can't call the JS matcher),
// mirroring IOP_CANONICAL_NAMES in lib/followup-iop.ts.
export const AUDIOGRAM_CANONICAL_NAMES: readonly string[] =
  AUDIOGRAM_EARS.flatMap((ear) =>
    AUDIOGRAM_FREQUENCIES_HZ.map((hz) => audiogramAnalyteName(ear, hz))
  );

// The inverse: recover (ear, frequency) from a stored analyte name, or null when the
// name is not an audiogram threshold. Tolerant of case and of the "1000 Hz" spelling a
// non-canonical source might use, so a future import mapper can reuse it.
export function parseAudiogramAnalyte(
  name: string | null | undefined
): { ear: AudiogramEar; hz: AudiogramFrequencyHz } | null {
  const s = (name ?? "").trim().toLowerCase();
  if (!s.includes("hearing threshold")) return null;
  const ear: AudiogramEar | null = /\bright\b/.test(s)
    ? "right"
    : /\bleft\b/.test(s)
      ? "left"
      : null;
  if (!ear) return null;
  const m = /(\d+(?:\.\d+)?)\s*(k?)hz/.exec(s);
  if (!m) return null;
  const hz = Number(m[1]) * (m[2] === "k" ? 1000 : 1);
  return isAudiogramFrequency(hz) ? { ear, hz } : null;
}

// The form field name carrying one (ear, frequency) threshold. Lives here, beside the
// vocabulary, so the client form and the Server Action's parser read it from the same
// place and can't drift on spelling.
export function audiogramFieldName(
  ear: AudiogramEar,
  hz: AudiogramFrequencyHz
): string {
  return `${ear}_${hz}`;
}

// THE DOMAIN'S CANONICAL IDENTITY FUNCTION — one trendable series per ear per
// frequency (the #713 singleton-identity ruling). This is what `latestByGroup`
// partitions on; nothing else may re-derive it.
export function audiogramSeriesKey(
  ear: AudiogramEar,
  hz: AudiogramFrequencyHz
): string {
  return `${ear}:${hz}`;
}

// ---- Reading + audiogram shapes ---------------------------------------------

// One stored threshold reading. Extends LatestRow (date + id) so it drops straight
// into the shared latest-per-group helper.
export interface AudiogramReading extends LatestRow {
  ear: AudiogramEar;
  hz: AudiogramFrequencyHz;
  dbHl: number;
  notes: string | null;
  flag: string | null;
}

export interface AudiogramPoint {
  ear: AudiogramEar;
  hz: AudiogramFrequencyHz;
  dbHl: number;
}

// One dated hearing test: the readings that share a date, which is how a user thinks
// about it ("my audiogram from March"). Derived, never stored — see the store note.
export interface Audiogram {
  date: string;
  readings: AudiogramReading[];
  notes: string | null;
}

// Group threshold readings into dated audiograms, NEWEST FIRST; within an audiogram
// the readings are ordered right ear then left, low → high frequency, so the rendered
// table is stable regardless of insert order. A date's notes are the first non-empty
// note among its readings (the form writes one note onto every row of a session).
export function groupAudiogramReadings(
  readings: readonly AudiogramReading[]
): Audiogram[] {
  const byDate = new Map<string, AudiogramReading[]>();
  for (const r of readings) {
    const list = byDate.get(r.date);
    if (list) list.push(r);
    else byDate.set(r.date, [r]);
  }
  const order = new Map(
    AUDIOGRAM_CANONICAL_NAMES.map((n, i) => [n, i] as const)
  );
  const rank = (r: AudiogramReading) =>
    order.get(audiogramAnalyteName(r.ear, r.hz)) ?? Number.MAX_SAFE_INTEGER;
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
    .map(([date, rows]) => ({
      date,
      readings: [...rows].sort((a, b) => rank(a) - rank(b) || a.id - b.id),
      notes: rows.find((r) => (r.notes ?? "").trim().length > 0)?.notes ?? null,
    }));
}

// THE latest-per-group answer for this domain: which threshold is CURRENT for each
// ear/frequency series. Routes through the shared `latestByGroup` (issue #944) keyed on
// the domain identity, so "current" here can never disagree with the Biomarkers
// is_latest marker. A partial re-test (say 4 kHz only) correctly refreshes just that
// series and leaves the rest standing — which is why this is not "the newest date's
// rows".
export function currentThresholds(
  readings: readonly AudiogramReading[]
): Map<string, AudiogramReading> {
  return latestByGroup(readings, (r) => audiogramSeriesKey(r.ear, r.hz));
}

// ---- Interpretation ---------------------------------------------------------

// The WHO/ASHA normal band the canonical dataset carries (`ref_high: 25`). Kept here
// as well so the pure interpretation below never has to load the JSON dataset.
export const NORMAL_THRESHOLD_DB_HL = 25;

export interface PureToneAverage {
  ear: AudiogramEar;
  dbHl: number;
  // Which of PTA_FREQUENCIES_HZ actually contributed (an audiogram may be partial).
  usedHz: number[];
}

// The pure-tone average for one ear over whatever PTA frequencies are present, or null
// when none are. Rounded to the nearest whole dB — audiometry is measured in 5 dB
// steps, so decimals would imply precision the measurement does not have.
export function pureToneAverage(
  points: readonly AudiogramPoint[],
  ear: AudiogramEar
): PureToneAverage | null {
  const used = PTA_FREQUENCIES_HZ.map((hz) =>
    points.find((p) => p.ear === ear && p.hz === hz)
  ).filter((p): p is AudiogramPoint => p != null);
  if (used.length === 0) return null;
  const sum = used.reduce((acc, p) => acc + p.dbHl, 0);
  return {
    ear,
    dbHl: Math.round(sum / used.length),
    usedHz: used.map((p) => p.hz),
  };
}

export type HearingGrade =
  "normal" | "mild" | "moderate" | "moderately-severe" | "severe" | "profound";

// The descriptive grade for a pure-tone average, on the classic (Goodman/ASHA) bands
// whose "normal ≤ 25 dB HL" boundary matches the `ref_high: 25` already curated for
// these analytes. DESCRIPTIVE ONLY — this names what the numbers say, it never
// diagnoses; the app tracks and compares, an audiologist interprets.
export function hearingGrade(dbHl: number): HearingGrade {
  if (dbHl <= NORMAL_THRESHOLD_DB_HL) return "normal";
  if (dbHl <= 40) return "mild";
  if (dbHl <= 55) return "moderate";
  if (dbHl <= 70) return "moderately-severe";
  if (dbHl <= 90) return "severe";
  return "profound";
}

export function hearingGradeLabel(grade: HearingGrade): string {
  switch (grade) {
    case "normal":
      return "Within the normal band";
    case "mild":
      return "Mild range";
    case "moderate":
      return "Moderate range";
    case "moderately-severe":
      return "Moderately severe range";
    case "severe":
      return "Severe range";
    case "profound":
      return "Profound range";
  }
}

// ---- Threshold shift (the #1600 payoff) -------------------------------------

// Which ASHA criterion a documented shift met.
export type ShiftCriterion = "single-20db" | "adjacent-10db";

export interface ThresholdShift {
  ear: AudiogramEar;
  criterion: ShiftCriterion;
  // The frequencies that satisfied the criterion, low → high.
  frequenciesHz: number[];
  // The largest worsening (in dB) among those frequencies, and where it was.
  worstDeltaDb: number;
  worstHz: number;
  baselineDbHl: number;
  currentDbHl: number;
}

// A SIGNIFICANT threshold shift between a baseline and a later audiogram, per ear, on
// the ASHA (1994) ototoxicity-monitoring criteria:
//   (a) ≥ 20 dB worsening at any ONE test frequency, or
//   (b) ≥ 10 dB worsening at TWO ADJACENT test frequencies, or
//   (c) loss of response at three consecutive frequencies where responses were
//       previously obtained.
// (a) and (b) are implemented. (c) is DELIBERATELY NOT: "no response at the limits of
// the audiometer" is a distinct datum from "threshold = N dB HL", and the store carries
// a number or nothing — an absent reading means "not tested", which is not the same
// claim. Encoding no-response would need a vocabulary decision (a sentinel value is
// exactly the kind of overloading that produces wrong all-clears), so it is left for a
// later change rather than faked here.
//
// Adjacency is over AUDIOGRAM_FREQUENCIES_HZ — the standard test ladder — restricted to
// frequencies present in BOTH audiograms, so a partial re-test compares only what it
// actually measured. At most one shift per ear is reported: criterion (a) when it
// applies (it is the stronger statement), otherwise (b). INFORMATIONAL, never
// prescriptive — this is "the numbers moved by this much", not a diagnosis.
export function detectThresholdShift(
  baseline: readonly AudiogramPoint[],
  current: readonly AudiogramPoint[]
): ThresholdShift[] {
  const shifts: ThresholdShift[] = [];
  for (const ear of AUDIOGRAM_EARS) {
    // Per-frequency worsening (positive = the ear now needs a LOUDER tone), for the
    // frequencies measured on both dates, in ladder order.
    const deltas = AUDIOGRAM_FREQUENCIES_HZ.map((hz) => {
      const b = baseline.find((p) => p.ear === ear && p.hz === hz);
      const c = current.find((p) => p.ear === ear && p.hz === hz);
      return b && c
        ? { hz, delta: c.dbHl - b.dbHl, baseline: b.dbHl, current: c.dbHl }
        : null;
    }).filter((d): d is NonNullable<typeof d> => d != null);
    if (deltas.length === 0) continue;

    // (a) ≥ 20 dB at any one frequency — the worst such frequency.
    const single = deltas
      .filter((d) => d.delta >= 20)
      .sort((a, b) => b.delta - a.delta || a.hz - b.hz)[0];
    if (single) {
      shifts.push({
        ear,
        criterion: "single-20db",
        frequenciesHz: [single.hz],
        worstDeltaDb: single.delta,
        worstHz: single.hz,
        baselineDbHl: single.baseline,
        currentDbHl: single.current,
      });
      continue;
    }

    // (b) ≥ 10 dB at two ADJACENT frequencies — the first such pair on the ladder,
    // which keeps the result deterministic. Adjacency is over the STANDARD LADDER, not
    // over "the frequencies this audiogram happened to test": a screening audiogram
    // that skips 2 kHz must not make 1 kHz and 4 kHz count as neighbours, because two
    // octaves apart is a different (weaker) claim than the criterion makes. The
    // conservative reading — a pair that skips a rung simply doesn't qualify.
    let pair: [(typeof deltas)[number], (typeof deltas)[number]] | null = null;
    for (let i = 0; i + 1 < AUDIOGRAM_FREQUENCIES_HZ.length; i++) {
      const a = deltas.find((d) => d.hz === AUDIOGRAM_FREQUENCIES_HZ[i]);
      const b = deltas.find((d) => d.hz === AUDIOGRAM_FREQUENCIES_HZ[i + 1]);
      if (a && b && a.delta >= 10 && b.delta >= 10) {
        pair = [a, b];
        break;
      }
    }
    if (pair) {
      const worst = pair[0].delta >= pair[1].delta ? pair[0] : pair[1];
      shifts.push({
        ear,
        criterion: "adjacent-10db",
        frequenciesHz: [pair[0].hz, pair[1].hz],
        worstDeltaDb: worst.delta,
        worstHz: worst.hz,
        baselineDbHl: worst.baseline,
        currentDbHl: worst.current,
      });
    }
  }
  return shifts;
}

// "20 dB at 4 kHz, right ear" / "15 dB across 4 and 8 kHz, left ear".
export function thresholdShiftLabel(shift: ThresholdShift): string {
  const freqs = shift.frequenciesHz.map(frequencyLabel);
  const where =
    freqs.length === 1
      ? `at ${freqs[0]}`
      : `across ${freqs.slice(0, -1).join(", ")} and ${freqs[freqs.length - 1]}`;
  return `${shift.worstDeltaDb} dB ${where}, ${earLabel(shift.ear)}`;
}

// ---- The hearing baseline the ototoxic crosscheck cites ---------------------

// What a hearing record contributes to a medication-safety note: the newest documented
// audiogram, and whether the thresholds have significantly shifted since the earliest
// one on file. Deliberately small and PURE — lib/ototoxic.ts (which a client component
// imports) takes this shape, never a DB reader.
export interface HearingBaseline {
  // The date of the newest audiogram on file.
  latestDate: string;
  // The date of the EARLIEST audiogram, when there is more than one (the comparison
  // point); null when only one audiogram exists, in which case `shifts` is empty.
  baselineDate: string | null;
  // The worst CURRENT threshold across every series, for the one-line citation.
  worst: AudiogramPoint | null;
  // Significant shifts per the ASHA criteria above; empty when none or when there is
  // nothing to compare against.
  shifts: ThresholdShift[];
}

// Build the baseline from a profile's threshold readings. The "current" side uses
// currentThresholds() — the shared latest-per-group answer — so the citation and the
// Biomarkers is_latest marker are the same computation; the comparison side is the
// EARLIEST dated audiogram, which is what "since your baseline" means clinically.
// Returns null when the profile has no audiogram at all (the crosscheck then says
// nothing extra — it must not nag for a test the user never had).
export function hearingBaselineFromReadings(
  readings: readonly AudiogramReading[]
): HearingBaseline | null {
  if (readings.length === 0) return null;
  const current = [...currentThresholds(readings).values()];
  if (current.length === 0) return null;

  const audiograms = groupAudiogramReadings(readings); // newest first
  const latestDate = current.reduce(
    (acc, r) => (r.date > acc ? r.date : acc),
    current[0].date
  );
  const earliest = audiograms[audiograms.length - 1];
  const baselineDate =
    audiograms.length > 1 && earliest.date < latestDate ? earliest.date : null;

  const point = (r: AudiogramReading): AudiogramPoint => ({
    ear: r.ear,
    hz: r.hz,
    dbHl: r.dbHl,
  });
  const worst = current.reduce((acc, r) => (r.dbHl > acc.dbHl ? r : acc));

  return {
    latestDate,
    baselineDate,
    worst: point(worst),
    shifts: baselineDate
      ? detectThresholdShift(earliest.readings.map(point), current.map(point))
      : [],
  };
}

// The one-sentence citation a safety note appends. Two shapes:
//   • no documented shift → the plain "there is a baseline on file, here it is" fact.
//   • a documented shift  → the conjunction #1600 exists for: on an ototoxic drug AND
//     the thresholds have measurably moved. Still factual, still never prescriptive —
//     the surrounding note already carries the "discuss with your prescriber" framing.
export function hearingBaselineSentence(baseline: HearingBaseline): string {
  const worst = baseline.worst
    ? `worst current threshold ${baseline.worst.dbHl} dB HL at ${frequencyLabel(
        baseline.worst.hz
      )}, ${earLabel(baseline.worst.ear)}`
    : "no numeric thresholds recorded";
  if (baseline.shifts.length === 0) {
    return `Hearing baseline on file: audiogram ${baseline.latestDate} (${worst}).`;
  }
  const detail = baseline.shifts.map(thresholdShiftLabel).join("; ");
  return (
    `Hearing baseline on file: audiogram ${baseline.latestDate} (${worst}) — ` +
    `a documented threshold shift since ${baseline.baselineDate}: ${detail} ` +
    `(ASHA ototoxicity-monitoring criteria).`
  );
}
