// The SKIN domain adapter for the finding → follow-up → resolution chain (issue #700 /
// #715 ask 3) — the final sibling of the imaging (lib/followup-imaging), flagged-labs
// (lib/followup-labs), IOP (lib/followup-iop), and dental (lib/followup-dental)
// adapters. PURE — it operates on SkinLesion shapes, no DB/network. It plugs into the
// domain-agnostic core (lib/followup.ts) by answering the same three domain questions:
// what a skin source finding reads as, what its follow-up is called, and which LATER
// lesion record resolves it — WITHOUT touching the core.
//
// A skin SOURCE finding is a skin_lesions row flagged for recheck: a "watch this mole,
// recheck in 3 months" record — status 'watch' carrying a follow_up_interval_days. That
// is the finding → follow-up → resolution chain a static lesion note would otherwise
// lose (the #700 blind spot). The RESOLUTION is a LATER record of the SAME lesion
// (identity = normalized body_region + body_side + label, #482) — the identity-anchored
// analogue of imaging's "a later study of the same anatomy resolves it" and dental's
// "a later record on the same tooth".
//
// ESCALATION rather than aging out (#715 ask 3): when the later record shows the lesion
// CHANGED, the user records 'changed' AND enters that later record as status 'watch'
// (evolving), which itself seeds a fresh recheck follow-up — so a changed lesion stays
// care-tier visible instead of silently closing. The core does the rest; this adapter
// only supplies the labels + the resolution match.
//
// SCOPE BOUNDARY (#715, LAW): every string here is INFORMATIONAL — "recheck",
// "compare", "record the outcome". Nothing asserts a lesion is concerning or scores the
// ABCDE observations into a verdict. The app tracks and compares.

import type { SkinLesion } from "./types/medical";
import {
  skinLesionDisplayLabel,
  bodyMapLabel,
  abcdeLetters,
  sameLesion,
} from "./skin-lesion";
import type { FollowUpAdapter, FollowUpItemLike } from "./followup";

// The skin source kind stored in care_plan_items.source_kind.
export const SKIN_FOLLOWUP_KIND = "skin";

// YYYY-MM of a record date (for the compact "(2026-03)" reason tail).
function recordMonth(l: Pick<SkinLesion, "observed_date">): string {
  return l.observed_date ? l.observed_date.slice(0, 7) : "";
}

// A short human label for the source lesion finding. Leads with the display label +
// body-map location, appends the recorded ABCDE letters when any are set (a NEUTRAL
// observation list, never a score), and pins WHICH record with a YYYY-MM tail so a
// serial view reads unambiguously across time.
export function skinSourceLabel(l: SkinLesion): string {
  const name = skinLesionDisplayLabel(l);
  const map = bodyMapLabel(l);
  const letters = abcdeLetters(l);
  const parts = [map ? `${name} · ${map}` : name];
  if (letters) parts.push(`ABCDE ${letters}`);
  const core = parts.join(" · ");
  const month = recordMonth(l);
  return month ? `${core} (${month})` : core;
}

// The default follow-up title. The lesion's display label narrows it — "Recheck skin
// lesion — left forearm mole"; otherwise the generic "Recheck skin lesion".
export function skinFollowUpTitle(l: SkinLesion): string {
  const name = skinLesionDisplayLabel(l);
  return name && name !== "Skin lesion"
    ? `Recheck skin lesion — ${name}`
    : "Recheck skin lesion";
}

// The later lesion record that resolves a follow-up for `source`, or null when none has
// landed. A candidate qualifies when it is a DIFFERENT record of the SAME lesion
// (strict identity match) whose observed_date is STRICTLY AFTER the source's date. The
// MOST RECENT wins. Confirm-first: returning a candidate only OFFERS the resolution.
export function findResolvingSkinRecord(
  source: SkinLesion,
  _followUp: FollowUpItemLike,
  candidates: readonly SkinLesion[]
): SkinLesion | null {
  if (!source.observed_date) return null; // undated source can't order candidates
  let best: SkinLesion | null = null;
  for (const c of candidates) {
    if (c.id === source.id) continue;
    if (!c.observed_date || c.observed_date <= source.observed_date) continue;
    if (!sameLesion(source, c)) continue;
    if (
      !best ||
      c.observed_date > best.observed_date! ||
      (c.observed_date === best.observed_date! && c.id > best.id)
    )
      best = c;
  }
  return best;
}

// A compact label for a resolving candidate, for the offer copy ("Left forearm mole ·
// 2026-09").
export function skinResolvingLabel(l: SkinLesion): string {
  const name = skinLesionDisplayLabel(l);
  const month = recordMonth(l);
  return month ? `${name} · ${month}` : name;
}

// The skin adapter instance the builder consumes. One object satisfying the generic
// FollowUpAdapter<Source, Candidate> contract — the seam imaging/labs/IOP/dental fill.
export const skinFollowUpAdapter: FollowUpAdapter<SkinLesion, SkinLesion> = {
  kind: SKIN_FOLLOWUP_KIND,
  describeSource: skinSourceLabel,
  followUpTitle: skinFollowUpTitle,
  findResolvingRecord: findResolvingSkinRecord,
  describeResolvingRecord: skinResolvingLabel,
};
