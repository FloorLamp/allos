// CDA section extractors — care teams. Extracts provider entries from a Care
// Teams section.
import type { ImportedProvider } from "../../health-import";
import { SECTIONS } from "../constants";
import type { CdaSection, SectionExtractor } from "../constants";
import {
  collectAssignedEntities,
  providerFromAssignedEntity,
  sectionIs,
} from "../normalize";

// Collect providers from the Care Teams section. Not a clinical
// reading — it names the patient's clinicians/orgs, which are registered into the
// shared registry. Deep-walks the section for assignedEntity nodes (their nesting
// under organizer/act/participant varies by EMR), preferring the named individual.
function providersFromCareTeams(section: CdaSection): ImportedProvider[] {
  const entities: any[] = [];
  for (const entry of section.entries) collectAssignedEntities(entry, entities);
  const out: ImportedProvider[] = [];
  for (const ae of entities) {
    const p = providerFromAssignedEntity(ae, "individual");
    if (p) out.push(p);
  }
  return out;
}

export const careTeamsExtractor: SectionExtractor = {
  key: "careTeams",
  matches: (s) => sectionIs(s, SECTIONS.careTeams),
  extract: (s) => ({ providers: providersFromCareTeams(s) }),
};
