// The summary row of the skin-lesion form (#5302, over #3218's primitive and #5300's
// grammar) — the first of slice 3's specialty forms.
//
// A SKIN LESION IS A PLACE ON A BODY, OBSERVED ON A DAY. The form asked thirteen
// labelled questions — label, region, side, size, status, observed date, five ABCDE
// checkboxes, recheck interval, finding, provider, visit, notes — for a record whose
// whole job is to be COMPARABLE with the next observation of the same mole. The
// LABEL stays above the chips as rule 1's one identifying field; the row states where
// the lesion is, when it was looked at, and what it is being tracked as; the rest fall
// behind the one trailing affordance.
//
// WHY `location` IS ESSENTIAL, and it is the sharpest of the three. The region and the
// side are two of the THREE components of `skinLesionIdentityKey` (#482) — the one
// function every skin surface keys on so serial records of the same mole gather
// together. `sameLesion` is STRICT on that tuple, and `findResolvingSkinRecord` will
// only accept a candidate it says is the same lesion, so a recheck recorded WITHOUT the
// region never resolves the watch record that HAS one: one mole's track silently splits
// in two and the follow-up stays open forever. The form's own action already treats
// this half as load-bearing — `addSkinLesion` refuses a lesion with neither a label nor
// a region ("Give the lesion a label or a body-map region") — and when the label is the
// blank half, the region is the only thing naming the lesion at all:
// `skinLesionDisplayLabel` falls back to a body-map name, and with no region either it
// falls all the way to a bare "Skin lesion", which `skinFollowUpTitle` then turns into
// the generic "Recheck skin lesion". The region and the side are ONE chip over ONE
// editor, because `bodyMapLabel` already reads them back as one line ("Left forearm")
// everywhere else and two chips would state one place twice.
//
// AND WHY `observed` IS ESSENTIAL. An undated lesion is not a thinner record, it is an
// unresolvable one: `findResolvingSkinRecord` returns null on the first line when the
// source has no `observed_date` ("undated source can't order candidates"), and skips
// every candidate that has none, so a "watch this mole" record with no date can never
// be closed by the later look that closes it. `getSkinLesions` also orders on
// `COALESCE(observed_date, '')`, so the undated row sorts to the bottom of the very
// comparison it exists for.
//
// AND WHY `status` IS ALWAYS STATED. The select is born "active" and
// `normalizeSkinLesionStatus` degrades anything else onto the CHECK set, so the fact
// can never be absent and the more-line can never hold it — the allergy and injury
// forms' reading of the same case. Calling it optional would say the trailing
// affordance might hold it, which is false.
//
// WHY `abcde` IS OPTIONAL, which is the classification most likely to be got wrong
// here. #715's SCOPE LAW says the five ABCDE fields are user-recorded OBSERVATIONS and
// are never scored into a verdict. An empty set therefore means "nothing noticed",
// which is a complete and common answer — not an omission. A dashed prompt on every
// lesion would press for observations the app has promised never to grade, so the five
// go behind the trailing affordance as ONE fact over ONE editor, read back through
// `abcdeLetters` — the same neutral "A·B·E" the follow-up reason line already prints.
//
// AND WHY `recheck` IS OPTIONAL despite naming a follow-up. Nothing reads the stored
// `follow_up_interval_days` to schedule anything: `trackSkinFollowUp` takes its
// interval from the list's own scheduler (`interval_days`) and refuses a missing one
// there. The column is what an imported record SAID ("recheck in 3 months"), so its
// absence is absence and not a gap in the follow-up loop.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states, never this file's wording.
//
// Pure: no React, no DB, no clock. The form is a renderer over `skinLesionFactSummary`.

import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import { recordFactRow, type RecordFactSummary } from "./record-facts";
import {
  abcdeLetters,
  bodyMapLabel,
  skinLesionStatusLabel,
  type AbcdeKey,
} from "./skin-lesion";

// The facts, in the order the row draws them. The three essentials lead, and the
// qualifiers of the observation sit next to the observation they qualify.
export type SkinLesionFactKey =
  | "location"
  | "observed"
  | "status"
  | "size"
  | "abcde"
  | "recheck"
  | "finding"
  | "provider"
  | "visit"
  | "notes";

// The nouns, so the trailing affordance can name what it holds.
export const SKIN_LESION_FACT_NOUNS: Record<SkinLesionFactKey, string> = {
  location: "body map",
  observed: "observed date",
  status: "status",
  size: "size",
  abcde: "ABCDE observations",
  recheck: "recheck interval",
  finding: "finding",
  provider: "provider",
  visit: "visit",
  notes: "notes",
};

export interface SkinLesionFactInput {
  /** The coarse region select's value — blank means the row cannot say where. */
  bodyRegion: string;
  /** Qualifies the location chip; never a chip of its own. */
  bodySide: string;
  observedDate: string;
  /** Born "active" and normalized on the server, so never blank. */
  status: string;
  /** The millimetre field as the number input holds it. */
  sizeMm: string;
  /** The five checkboxes exactly as the form holds them; read back as one line. */
  abcde: Record<AbcdeKey, boolean>;
  /** The recheck cadence as the number input holds it. */
  recheckDays: string;
  finding: string;
  provider: string;
  /** The linked visit's LABEL, mirrored off the picker. */
  visit: string;
  /**
   * Whether this profile has any visit to link at all. The picker renders nothing when
   * it has none, so the row must not offer the fact either (the allergy form's rule).
   */
  linkableVisits: boolean;
  notes: string;
  prefs?: DisplayFormatPrefs;
}

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 */
export function skinLesionFactSummary(
  f: SkinLesionFactInput
): RecordFactSummary<SkinLesionFactKey> {
  const prefs = f.prefs ?? DEFAULT_FORMAT_PREFS;
  const row = recordFactRow<SkinLesionFactKey>();

  // Through the ONE labeller the list, the follow-up reason and the search projection
  // already read these two columns with, so the chip cannot state a place differently
  // from the row it will become. "" when the region is unknown — a side with no region
  // is not a location, which is `bodyMapLabel`'s own rule and not one re-decided here.
  const map = bodyMapLabel({
    body_region: f.bodyRegion || null,
    body_side: f.bodySide || null,
  });
  if (map) row.stated("location", map);
  else row.missing("location", "Add a body-map region");

  const observed = f.observedDate.trim();
  if (observed) row.stated("observed", `Observed ${formatMonthDay(observed, prefs)}`);
  else row.missing("observed", "Add the observation date");

  row.stated("status", skinLesionStatusLabel(f.status));

  const size = f.sizeMm.trim();
  row.state("size", size, size ? `${size} mm` : "");
  // The five observations as the ONE neutral letter list every other surface prints —
  // never a count, never a threshold, never a verdict (#715 scope law).
  const letters = abcdeLetters({
    asymmetry: f.abcde.asymmetry ? 1 : 0,
    border: f.abcde.border ? 1 : 0,
    color: f.abcde.color ? 1 : 0,
    diameter: f.abcde.diameter ? 1 : 0,
    evolving: f.abcde.evolving ? 1 : 0,
  });
  row.state("abcde", letters, letters ? `ABCDE ${letters}` : "");
  const recheck = f.recheckDays.trim();
  row.state("recheck", recheck, recheck ? `Recheck in ${recheck} days` : "");
  // The finding MARKER, not the finding: a dermatologist's impression is a paragraph,
  // and a chip states a fact (the visit row's reading of the same shape).
  row.state("finding", f.finding, "Finding noted");
  row.state("provider", f.provider, f.provider.trim());
  if (f.linkableVisits) row.state("visit", f.visit, f.visit.trim());
  // The notes MARKER, not the notes.
  row.state("notes", f.notes, "Notes added");

  return row.summary();
}
