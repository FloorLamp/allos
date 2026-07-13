// CDA section extractors — immunizations. Maps a substanceAdministration to an
// ImportedImmunization and the immunizations section extractor.
import { codeFromVaccineCode } from "../../cvx-map";
import type { ImportedImmunization } from "../../health-import";
import { SECTIONS } from "../constants";
import type { SectionExtractor } from "../constants";
import {
  effTime,
  providerFromPerformer,
  sectionIs,
  textOf,
  truthyNegation,
  vaccineCodeFrom,
} from "../normalize";

export function mapImmunization(sa: any): ImportedImmunization | null {
  if (!sa || truthyNegation(sa["@_negationInd"])) return null;
  const date = effTime(sa.effectiveTime);
  const mat = sa?.consumable?.manufacturedProduct?.manufacturedMaterial;
  if (!date || !mat?.code) return null;
  const catalog = codeFromVaccineCode(vaccineCodeFrom(mat.code));
  if (!catalog) return null;
  const lot = textOf(mat?.lotNumberText)?.trim();
  return {
    code: catalog,
    date,
    dose_label: null,
    notes: lot ? `Lot ${lot}` : null,
    external_id: `ccda:${catalog}:${date}`,
    // Who administered the shot / at what facility (CCD <performer>) — kept as
    // provenance rather than dropped.
    provider: providerFromPerformer(sa),
  };
}

export const immunizationExtractor: SectionExtractor = {
  key: "immunizations",
  matches: (s) => sectionIs(s, SECTIONS.immunizations),
  extract: (s) => ({
    immunizations: s.entries
      .map((e) => mapImmunization(e?.substanceAdministration))
      .filter((x): x is ImportedImmunization => x != null),
  }),
};
