import { expandToComponents, vaccineDisplayName } from "./immunization-catalog";
import { resolveDoseLabels, seriesLengthForCode } from "./immunization-status";

// Pure assembly of the PRINTABLE IMMUNIZATION RECORD (issue #1849) — the artifact a
// registrar, camp, employer or travel clinic asks for. The stored administration
// facts (lot / route / site / provider) exist precisely because those forms ask for
// them, so this shape is transcription-ordered: grouped by vaccine, doses oldest→
// newest inside each group, one row per dose with every stated fact and an em dash
// for every unstated one — never a guess.
//
// DB- and DOM-free (unit-tested in lib/__tests__/immunization-record.test.ts). The
// gather lives in app/(app)/immunizations/record-data.ts and the single view
// component renders it for both the print page and the tokenized /share view, so
// the two can't drift.
//
// Grouping follows the passport's crediting rule (buildPassportImmunizations): a
// combination shot is expanded to its components, so a Vaxelis dose appears under
// DTaP, Hib, IPV and HepB — which is exactly how a school form wants to read it —
// and each row names the PRODUCT actually administered so the expansion is never
// mistaken for four separate injections.

export interface ImmunizationRecordInput {
  id: number;
  date: string;
  vaccine: string; // stored code (catalog, combo, or an unknown slug)
  dose_label: string | null;
  lot_number: string | null;
  route: string | null;
  site: string | null;
  provider_name?: string | null;
  reaction: string | null;
}

export interface ImmunizationRecordDose {
  id: number;
  date: string;
  // "Dose 2 of 4", or the user's own label when they set one.
  label: string;
  // The product administered, when it differs from the group's vaccine (a
  // combination shot crediting this series); null when they are the same, so the
  // column stays quiet for the ordinary case.
  product: string | null;
  lot: string | null;
  route: string | null; // raw stored route; the view labels it
  site: string | null;
  provider: string | null;
  reaction: string | null;
}

export interface ImmunizationRecordGroup {
  code: string;
  name: string;
  doses: ImmunizationRecordDose[];
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t ? t : null;
};

// Build the grouped record from a profile's stored doses. Records with no date are
// dropped (an undated dose can't be transcribed onto a form and can't be numbered);
// an unknown vaccine slug groups under itself rather than vanishing.
export function buildImmunizationRecord(
  records: readonly ImmunizationRecordInput[]
): ImmunizationRecordGroup[] {
  const byCode = new Map<string, ImmunizationRecordInput[]>();
  for (const r of records) {
    if (!r.date) continue;
    const codes = expandToComponents(r.vaccine);
    for (const code of codes.length > 0 ? codes : [r.vaccine]) {
      const list = byCode.get(code);
      if (list) list.push(r);
      else byCode.set(code, [r]);
    }
  }

  const groups: ImmunizationRecordGroup[] = [];
  for (const [code, crediting] of byCode) {
    // Numbered within THIS series (the group's own sequence and series length), so a
    // combination shot is counted once per component series — the numbering a form
    // asks for ("DTaP dose 3 of 5").
    const labels = resolveDoseLabels(crediting, seriesLengthForCode(code));
    const doses = [...crediting]
      .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id)
      .map((r) => ({
        id: r.id,
        date: r.date,
        label: labels.get(r.id) ?? "",
        product: r.vaccine === code ? null : vaccineDisplayName(r.vaccine),
        lot: clean(r.lot_number),
        route: clean(r.route),
        site: clean(r.site),
        provider: clean(r.provider_name),
        reaction: clean(r.reaction),
      }));
    groups.push({ code, name: vaccineDisplayName(code), doses });
  }

  // Alphabetical by vaccine name: a transcriber scanning a paper form for one row
  // wants a predictable order, not a clinical ranking.
  return groups.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

// Total doses on the record (groups double-count a combination shot, so this counts
// distinct stored doses) — the header's "N doses across M vaccines" line.
export function immunizationRecordDoseCount(
  groups: readonly ImmunizationRecordGroup[]
): number {
  const ids = new Set<number>();
  for (const g of groups) for (const d of g.doses) ids.add(d.id);
  return ids.size;
}
