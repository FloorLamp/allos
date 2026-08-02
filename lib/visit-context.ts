// Visit context (#1350): the cheap "this isn't your first rodeo" read a visit detail
// page shows under its hero — "3rd visit with Dr. Patel · last one Mar 2026" and
// "2nd urgent-care visit this year". Pure ordinal math over the profile's other
// encounters; the DB gather (lib/queries) feeds it the deduped representative rows and
// the page formats the result. Type cadence uses the displayed visit type rather than
// the coarse setting bucket. No context on a genuine first visit (ordinal 1) — the
// point is continuity, so a lone visit stays silent (the #489 absent-pillar rule).
// One of the profile's OTHER visits, reduced to just the axes context keys on: when
// it happened, who it was with, and its displayed-type identity. The subject visit
// is passed separately as `current`.
export interface PriorVisit {
  date: string; // YYYY-MM-DD
  providerId: number | null;
  typeKey: string;
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
  // Same-type-this-year cadence — present only when this is at least the 2nd visit
  // with the same displayed visit type in the subject visit's calendar year. This is
  // intentionally finer than encounterKind(): a dental visit and an office visit may
  // both be ambulatory, but they are not the same type to a person reading the page.
  typeYear: {
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

  let typeYear: VisitContext["typeYear"] = null;
  const y = yearOf(current.date);
  const sameTypeYear = others.filter(
    (o) =>
      o.typeKey === current.typeKey &&
      yearOf(o.date) === y &&
      o.date <= current.date
  );
  const typeOrdinal = sameTypeYear.length + 1;
  if (typeOrdinal >= 2) typeYear = { ordinal: typeOrdinal };

  return { provider, typeYear };
}
