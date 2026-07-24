// Visit context (#1350): the cheap "this isn't your first rodeo" read a visit detail
// page shows under its hero — "3rd visit with Dr. Patel · last one Mar 2026" and
// "2nd urgent-care visit this year". Pure ordinal math over the profile's other
// encounters; the DB gather (lib/queries) feeds it the deduped representative rows and
// the page formats the result. No context on a genuine first visit (ordinal 1) — the
// point is continuity, so a lone visit stays silent (the #489 absent-pillar rule).
import type { EncounterKind } from "@/lib/encounter-kind";

// One of the profile's OTHER visits, reduced to just the axes context keys on: when
// it happened, who it was with, and its coarse kind (#1319). The subject visit is
// passed separately as `current`.
export interface PriorVisit {
  date: string; // YYYY-MM-DD
  providerId: number | null;
  kind: EncounterKind;
}

export interface VisitContextSubject extends PriorVisit {
  providerName: string | null;
}

export interface VisitContext {
  // Same-provider continuity — present only when this visit has a same-provider
  // predecessor (ordinal ≥ 2) and the provider is named. `ordinal` is this visit's
  // chronological position in the same-provider series (1-based); `priorDate` is the
  // most recent EARLIER same-provider visit, or null when the predecessor shares this
  // date.
  provider: {
    name: string;
    ordinal: number;
    priorDate: string | null;
  } | null;
  // Same-kind-this-year cadence — present only when this is at least the 2nd visit of
  // its kind in the subject visit's calendar year. `ordinal` is 1-based within the year.
  kindYear: {
    ordinal: number;
  } | null;
}

const yearOf = (date: string): string => date.slice(0, 4);

// Derive the visit context of `current` from the profile's `others` (every OTHER
// deduped visit). Ordinals count the subject visit plus every earlier-or-same-day
// peer on the matching axis, so the subject's own position is 1-based and stable
// regardless of input order.
export function visitContext(
  current: VisitContextSubject,
  others: PriorVisit[]
): VisitContext {
  let provider: VisitContext["provider"] = null;
  if (current.providerId != null && current.providerName) {
    const samePriorOrSame = others.filter(
      (o) => o.providerId === current.providerId && o.date <= current.date
    );
    const ordinal = samePriorOrSame.length + 1;
    if (ordinal >= 2) {
      const earlier = samePriorOrSame
        .filter((o) => o.date < current.date)
        .map((o) => o.date)
        .sort();
      provider = {
        name: current.providerName,
        ordinal,
        priorDate: earlier.length ? earlier[earlier.length - 1] : null,
      };
    }
  }

  let kindYear: VisitContext["kindYear"] = null;
  const y = yearOf(current.date);
  const sameKindYear = others.filter(
    (o) =>
      o.kind === current.kind && yearOf(o.date) === y && o.date <= current.date
  );
  const kindOrdinal = sameKindYear.length + 1;
  if (kindOrdinal >= 2) kindYear = { ordinal: kindOrdinal };

  return { provider, kindYear };
}
