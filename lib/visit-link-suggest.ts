// Record ↔ visit and episode ↔ visit link SUGGESTION engine (issues #1050/#1053).
//
import { daysBetweenDateStr } from "./date";
//
// PURE — no DB, no network. Every function takes already-loaded rows and returns
// plain data, so the whole file is exhaustively unit-testable (the confidence
// matrix, the ≥2-encounter picker rule, the episode-containment rule, the
// decision-filter). The DB read/derive layer that feeds these rows in and persists
// the outcome lives in lib/queries/visit-links.ts; the accept/decline/manual-link
// actions live in the record/episode/medication action modules.
//
// DESIGN (from #1050). Suggestions are DERIVED AT READ TIME over whatever rows exist
// now — never minted at import, never stored — so existing records are covered with
// no backfill, late-arriving data pairs in both directions for free, and editing a
// record's date/provider self-corrects the set on next render. The ONLY stored tier-2
// state is the accept/decline DECISION (visit_link_decisions), keyed on stable
// identity tokens so it survives the delete-and-reinsert reprocess.
//
// TIERS (record ↔ visit):
//   - strong: same profile + same date + the record's provider matches the
//     encounter's attending clinician (provider_id) or its facility
//     (location_provider_id).
//   - medium: same date + exactly ONE encounter that day (no provider corroboration).
//   - AMBIGUITY (hard, #531/#534): a record whose date matches ≥2 encounters gets a
//     PICKER, never a ranked guess — UNLESS provider corroboration resolves to
//     exactly one candidate (corroboration is a match, not a guess). No suggestion at
//     all when dates don't match exactly (no fuzzy windows in v1).

// #1178 removed the `record` domain: an imported prescription is no longer a
// medical_records category='prescription' row (its own candidate domain) — it is the
// SINGLE `medication` (intake_items) entity, so a prescription is ONE candidate and
// the cross-domain double-listing symptom is gone at the root.
export type VisitLinkDomain =
  | "condition"
  | "procedure"
  | "imaging"
  | "immunization"
  | "medication"
  | "optical"
  | "dental"
  | "episode";

export type VisitLinkConfidence = "strong" | "medium";

// A row's STABLE identity token — the crux of decision durability. An imported row
// keeps its external_id verbatim across reprocess (row ids churn), so we key on it;
// a manual row (external_id null) never churns, so its id is stable. Mirrors the
// import-review activityToken precedent exactly.
export function stableToken(row: {
  id: number;
  external_id?: string | null;
}): string {
  return row.external_id ? `ext:${row.external_id}` : `id:${row.id}`;
}

// The order-independent signature of a (encounter, target) pair — a sorted join of
// the two stable tokens, so a decision re-derives identically after row ids change.
export function visitLinkSignature(
  encounterToken: string,
  targetToken: string
): string {
  return [encounterToken, targetToken].sort().join("::");
}

// A visit-anchored record eligible for linking (already UNLINKED — the caller
// excludes rows whose encounter_id is set). `providerId` is the record's own
// provider (prescriber / performer / ordering clinician), used for corroboration.
export interface LinkableRecord {
  domain: VisitLinkDomain;
  id: number;
  external_id: string | null;
  date: string | null; // YYYY-MM-DD
  providerId: number | null;
  // A short human label for the UI (drug name, lab name, condition name, …).
  label: string;
}

export interface LinkableEncounter {
  id: number;
  external_id: string | null;
  date: string; // YYYY-MM-DD
  providerId: number | null; // attending clinician
  locationProviderId: number | null; // facility
}

// One record's suggestion: either a single confident pick (`encounter` +
// `confidence`) or a `candidates` picker (≥2 same-day, unresolved). Never both.
export interface RecordVisitSuggestion {
  record: LinkableRecord;
  encounter?: LinkableEncounter;
  confidence?: VisitLinkConfidence;
  candidates?: LinkableEncounter[];
}

// Does the record's provider corroborate this encounter (same clinician OR facility)?
function corroborates(rec: LinkableRecord, enc: LinkableEncounter): boolean {
  if (rec.providerId == null) return false;
  return (
    enc.providerId === rec.providerId ||
    enc.locationProviderId === rec.providerId
  );
}

// Suggest a visit link for ONE unlinked record against the profile's encounters,
// minus any (encounter, record) pair the user already declined. Returns null when
// nothing matches (no same-date encounter, or every same-date encounter declined).
export function suggestForRecord(
  rec: LinkableRecord,
  encounters: LinkableEncounter[],
  declinedSignatures: ReadonlySet<string>
): RecordVisitSuggestion | null {
  if (!rec.date) return null;
  const recToken = stableToken(rec);
  const sameDay = encounters.filter(
    (e) =>
      e.date === rec.date &&
      !declinedSignatures.has(visitLinkSignature(stableToken(e), recToken))
  );
  if (sameDay.length === 0) return null;

  if (sameDay.length === 1) {
    return {
      record: rec,
      encounter: sameDay[0],
      confidence: corroborates(rec, sameDay[0]) ? "strong" : "medium",
    };
  }

  // ≥2 same-day encounters. Provider corroboration may resolve to exactly one — a
  // determinate match, not a ranked guess — otherwise a PICKER (never guess, #534).
  const corroborated = sameDay.filter((e) => corroborates(rec, e));
  if (corroborated.length === 1) {
    return { record: rec, encounter: corroborated[0], confidence: "strong" };
  }
  return { record: rec, candidates: sameDay };
}

// Suggest links for a batch of unlinked records (the encounter page's "From this
// visit?" block reads the inverse — see suggestForEncounter). Drops records with no
// suggestion.
export function suggestForRecords(
  records: LinkableRecord[],
  encounters: LinkableEncounter[],
  declinedSignatures: ReadonlySet<string>
): RecordVisitSuggestion[] {
  const out: RecordVisitSuggestion[] = [];
  for (const rec of records) {
    const s = suggestForRecord(rec, encounters, declinedSignatures);
    if (s) out.push(s);
  }
  return out;
}

// The ENCOUNTER-side view: which unlinked records look like they belong to THIS one
// visit. A record is offered here only when the visit is its single confident pick
// (strong or medium) — an ambiguous record (its date matched ≥2 encounters and
// provider didn't resolve it) is NOT auto-offered under any one visit; it surfaces
// as a picker on the record's own page instead. This keeps the encounter's batch
// "link all" honest — every row in it resolves uniquely to this visit.
export interface EncounterFromVisit {
  suggestions: { record: LinkableRecord; confidence: VisitLinkConfidence }[];
}

export function suggestForEncounter(
  encounter: LinkableEncounter,
  records: LinkableRecord[],
  declinedSignatures: ReadonlySet<string>
): EncounterFromVisit {
  const suggestions: EncounterFromVisit["suggestions"] = [];
  for (const rec of records) {
    const s = suggestForRecord(rec, [encounter], declinedSignatures);
    // suggestForRecord over a single-encounter list can only ever return a single
    // pick (never a picker), so `s.encounter` is this encounter when it matched.
    if (s?.encounter && s.encounter.id === encounter.id && s.confidence) {
      suggestions.push({ record: rec, confidence: s.confidence });
    }
  }
  return { suggestions };
}

// ── Episode ↔ visit (#1053) ─────────────────────────────────────────────────────
//
// An encounter dated WITHIN an episode's range (start → lastActiveDay, inclusive,
// exact containment — no fuzzy windows) is a strong suggestion. 0 in range ⇒
// nothing; exactly 1 ⇒ a single suggestion (still user-accepted — a routine cleaning
// during a cold week is in-range and unrelated, so containment is a suggestion
// signal, not proof); ≥2 in range ⇒ a picker, never a ranked guess (#534). No
// provider tiering — containment is the only signal. Declined pairs are filtered.

export interface EpisodeRange {
  id: number; // episodes have stable ids — the token is `id:<id>`
  start: string | null; // YYYY-MM-DD
  lastActiveDay: string | null; // YYYY-MM-DD
}

export interface EpisodeVisitSuggestion {
  // A single in-range visit (the caller shows "Seen at …, link this visit?").
  encounter?: LinkableEncounter;
  // OR ≥2 in-range visits — a picker.
  candidates?: LinkableEncounter[];
}

// The episode's stable token, for pairing with an encounter token in a decision.
export function episodeToken(episode: { id: number }): string {
  return `id:${episode.id}`;
}

export function encounterInEpisodeRange(
  episode: EpisodeRange,
  encounterDate: string
): boolean {
  if (!episode.start || !episode.lastActiveDay) return false;
  return (
    encounterDate >= episode.start && encounterDate <= episode.lastActiveDay
  );
}

export function suggestForEpisode(
  episode: EpisodeRange,
  encounters: LinkableEncounter[],
  declinedSignatures: ReadonlySet<string>
): EpisodeVisitSuggestion | null {
  const epToken = episodeToken(episode);
  const inRange = encounters.filter(
    (e) =>
      encounterInEpisodeRange(episode, e.date) &&
      !declinedSignatures.has(visitLinkSignature(stableToken(e), epToken))
  );
  if (inRange.length === 0) return null;
  if (inRange.length === 1) return { encounter: inRange[0] };
  return { candidates: inRange };
}

// ── Manual "Link a visit…" picker ordering (#1196) ───────────────────────────────
//
// The episode Care line's manual override lists in-range visits first, then offers
// out-of-range ones too (the auto-detected window is a heuristic; a genuinely related
// follow-up/pre-symptom visit legitimately falls just outside it). The DEFECT: the
// out-of-range candidates were tie-broken by `id` DESCENDING (most-recently-CREATED),
// which has nothing to do with how close a visit is to the episode — so a 2026 physical
// crowded a just-outside follow-up out of the top 8. The fix orders the out-of-range set
// by DATE PROXIMITY to the episode window.

// The day-gap from a visit date to the episode window [firstDay, lastActiveDay]: 0 when
// the date is inside the window (or the window is unknown — no proximity to measure),
// else the distance to the nearer edge. Pure/testable.
export function distanceToWindow(
  date: string,
  firstDay: string | null,
  lastActiveDay: string | null
): number {
  if (!firstDay || !lastActiveDay) return 0;
  if (date >= firstDay && date <= lastActiveDay) return 0;
  const before = daysBetweenDateStr(date, firstDay); // >0 when date is before window
  const after = daysBetweenDateStr(lastActiveDay, date); // >0 when date is after window
  const gap =
    date < firstDay ? (before ?? 0) : after ?? 0;
  return Math.abs(gap);
}

export interface EpisodeManualCandidate {
  id: number;
  date: string;
}

// Order the "Link a visit…" candidates for an episode: in-range visits first, then
// out-of-range by DATE PROXIMITY to the window (nearest edge first), then id-descending
// as the final deterministic tie-break. Optionally BOUNDS the out-of-range set to a
// sensible neighborhood (`maxOutOfRangeGapDays`, default 60) so a short episode with no
// nearby visit shows just its in-range set rather than padding to `cap` with distant
// unrelated visits (#1196's "nicety" — proximity ordering alone fixes the crowd-out, the
// bound keeps the far tail out entirely). In-range visits are NEVER bounded out. Caps at
// `cap` (default 8). Pure; the page maps the returned rows to labels.
export function orderEpisodeManualCandidates<T extends EpisodeManualCandidate>(
  candidates: T[],
  firstDay: string | null,
  lastActiveDay: string | null,
  opts?: { cap?: number; maxOutOfRangeGapDays?: number }
): T[] {
  const cap = opts?.cap ?? 8;
  const maxGap = opts?.maxOutOfRangeGapDays ?? 60;
  const inRange = (d: string) =>
    !!firstDay && !!lastActiveDay && d >= firstDay && d <= lastActiveDay;
  return candidates
    .filter(
      (c) => inRange(c.date) || distanceToWindow(c.date, firstDay, lastActiveDay) <= maxGap
    )
    .sort((a, b) => {
      const ar = inRange(a.date) ? 1 : 0;
      const br = inRange(b.date) ? 1 : 0;
      if (br !== ar) return br - ar;
      const ad = distanceToWindow(a.date, firstDay, lastActiveDay);
      const bd = distanceToWindow(b.date, firstDay, lastActiveDay);
      if (ad !== bd) return ad - bd;
      return a.id < b.id ? 1 : -1; // id only as a final deterministic tie-break
    })
    .slice(0, cap);
}

// ── "Create a visit from this record?" (#1099) ───────────────────────────────────
//
// The INVERSE of #1050's link-to-existing: some records IMPLY a visit happened (an
// optical Rx ⇒ an eye exam, a completed dental procedure ⇒ a dental visit, an imaging
// study ⇒ a radiology visit) but no encounter row exists. This offers a one-tap
// affordance to create a skeleton encounter from the record — NEVER a silent
// auto-create (the #560/#817/#1053 never-fabricate posture).
//
// SCOPE: only the three visit-implying record types with a structured date + provider
// (optical_prescriptions, dental_procedures, imaging_studies). Labs/vitals are
// deliberately excluded — a lab draw's "visit" is often not a meaningful encounter.
//
// READ-TIME, no stored suggestion state (the #1050 stance). The prompt condition is
// derived on render from the current rows, so a late-arriving encounter self-heals it
// away. The ONLY stored state is the accept (the created encounter + its link) and the
// DECLINE decision (visit_link_decisions with the `create` sentinel encounter_key).
//
// THE GUARD (safety): the prompt is SUPPRESSED whenever an encounter exists on date D.
// Encounters carry no structured `kind` column — only free-text `type` — and #1050's
// link/picker already fires for ANY same-day encounter (it does not kind-filter). So
// keying the #1099 create-suppression on "any same-day encounter" makes create and
// #1050's link/picker mutually exclusive by construction: a record shows EITHER
// "Create a visit" (no same-day encounter) OR #1050's link/picker (≥1 same-day
// encounter), never both. That directly realizes the issue's "then the correct
// affordance is #1050's link suggestion" / "≥2 same-day → #1050's picker". A rare
// wrong-kind same-day collision yields a declinable #1050 link, not a spurious create
// (the conservative direction — never fabricate).

// The record types that can seed a "create a visit" offer.
export type CreateVisitDomain = "optical" | "dental" | "imaging";

export const CREATE_VISIT_DOMAINS: readonly CreateVisitDomain[] = [
  "optical",
  "dental",
  "imaging",
] as const;

export function isCreateVisitDomain(s: string): s is CreateVisitDomain {
  return (CREATE_VISIT_DOMAINS as readonly string[]).includes(s);
}

// The sentinel encounter-side token for a "create a visit" DECLINE decision: there is
// no encounter yet, so the decision is keyed (domain, `create`, <record stable
// token>). `create` can never collide with a real encounter token (`ext:`/`id:`).
export const CREATE_VISIT_ENCOUNTER_KEY = "create";

// A visit-implying record eligible to seed an encounter (already UNLINKED — the caller
// excludes rows whose encounter_id is set — and dated).
export interface CreateVisitCandidate {
  domain: CreateVisitDomain;
  id: number;
  external_id: string | null;
  date: string | null; // YYYY-MM-DD
  // A short human label for the UI (Rx kind, dental procedure name, imaging study).
  label: string;
}

// Should we offer to CREATE a visit from this record? Pure decision over the current
// rows. Offers only when the record is dated, NOT declined, and NO encounter exists on
// its date (else #1050's link/picker owns it). `sameDayEncounterCount` is the number
// of the profile's encounters dated on the record's date.
export function shouldOfferCreateVisit(
  rec: CreateVisitCandidate,
  sameDayEncounterCount: number,
  declined: boolean
): boolean {
  if (!rec.date) return false;
  if (declined) return false;
  if (sameDayEncounterCount > 0) return false;
  return true;
}
