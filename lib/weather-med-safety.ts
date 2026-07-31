// Pure medication × WEATHER safety cross-check (issue #1727) — the environmental twin
// of the ototoxic (lib/ototoxic.ts), contrast (lib/contrast-safety.ts), dental
// (lib/dental-safety.ts), drug–drug (lib/drug-interactions.ts), and PGx (lib/pgx.ts)
// checks. No DB, no network: given a profile's ACTIVE intake stack and the day's
// conditions, it returns the matched informational notes.
//
// COMPOSITION, NOT NEW NAGS — the load-bearing constraint of this issue. Two behaviors,
// and neither of them is a new send:
//
//   1. ENRICHMENT. On a day the UV overexposure heads-up already fires, a matching
//      photosensitizer adds ONE CLAUSE to that existing line ("… note: doxycycline
//      increases sun sensitivity"). It does not raise a second warning about the same
//      afternoon; enrichUvDetail below is that fold.
//   2. A STANDALONE CALM LINE, the one genuinely new reach the issue grants: on a
//      HIGH-UV day with a photosensitizer active but NO overexposure signal (nothing
//      logged outdoors yet, so there is no dose to warn about), the fact is still worth
//      knowing before going out. It rides the digest and Upcoming, with no dedicated
//      send of its own. The heatwave × heat-risk composition works the same way and
//      requires BOTH facts — the heatwave situation (#1726) and a matching item.
//
// DRUG IDENTITY (#482): concepts are matched by RxNorm ingredient CUI + synonym through
// the SHARED matchConceptKeysIn machinery (the same matcher the drug-interaction
// detector, PGx, ototoxic, and dental cross-checks use), NOT raw-name matching.
//
// KIND-BLIND BY CONSTRUCTION. The stack handed in is supplements AND medications: the
// sun does not care which surface an item was entered on, and St John's Wort is in the
// curated list precisely to make that concrete.
//
// OBLIGATION-BLIND (#1505, pinned). A `may` item is checked exactly like a `must` one.
// Obligation decides whether the app CONTACTS you about taking something; it says
// nothing about whether the drug in your body reacts to sunlight. A photosensitizer
// someone takes occasionally is still a photosensitizer on the day they take it.
//
// EVERYTHING HERE IS INFORMATIONAL, NEVER PRESCRIPTIVE. A note names a precaution and a
// conversation to have with the prescriber; it never says "stop your drug", never blocks
// anything, and the ABSENCE of a flag is NOT clearance (a curated subset; an
// unrecognized drug carries no flag). Fully OFFLINE.

import {
  WEATHER_MED_ENTRIES,
  type WeatherExposure,
  type WeatherMedEntry,
} from "./datasets/weather-med-safety";
import { matchConceptKeysIn } from "./drug-interactions";

// dedupeKey namespace for the shared findings-suppression bus — "dismiss once, silence
// everywhere". Keyed by the item id (ids never recycle, names do — #203), the matched
// entry key, and the DATE, so a dismissal silences that day's note and a new qualifying
// day surfaces fresh (the same date-keying the UV overexposure finding uses: the
// condition is a property of the day, not a standing fact about the med).
export const WEATHER_MED_PREFIX = "weather-med:";

export function weatherMedSignalKey(
  exposure: WeatherExposure,
  itemId: number,
  entryKey: string,
  date: string
): string {
  return `${WEATHER_MED_PREFIX}${exposure}:${itemId}:${entryKey}:${date}`;
}

// The informational guardrail appended to every standalone note (never prescriptive;
// absence of a flag is not clearance).
const GUARDRAIL =
  "Informational — a general note about the medication class, not advice to change " +
  "anything; discuss any concern with your prescriber, and the absence of a flag is " +
  "not clearance.";

// The intake fields the matcher reads — the active-item shape the shared safety-context
// gather already produces, plus the intake_items id for the dedupeKey / row anchor.
export interface WeatherMedInput {
  id: number;
  name: string;
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}

// One matched note: an active item resolves to a weather-sensitive drug concept.
export interface WeatherMedHit {
  itemId: number;
  itemName: string;
  exposure: WeatherExposure;
  // The matched entry's stable key (never user input) — part of the dedupeKey.
  entryKey: string;
  label: string;
  // The one-clause form, for folding into an existing line.
  clause: string;
  // The fuller note, for the standalone calm line.
  note: string;
  citation: string;
}

// The entries an active item resolves to for a given exposure — matched by RxCUI
// ingredient + synonym through the shared machinery (#482).
function entriesForItem(
  item: WeatherMedInput,
  exposure: WeatherExposure
): WeatherMedEntry[] {
  const pool = WEATHER_MED_ENTRIES.filter((e) => e.exposure === exposure);
  const keys = new Set(
    matchConceptKeysIn(
      {
        name: item.name,
        rxcui: item.rxcui,
        rxcuiIngredients: item.rxcuiIngredients ?? undefined,
      },
      pool
    )
  );
  return pool.filter((e) => keys.has(e.key));
}

// Every match between the profile's active stack and the curated table, for one
// exposure. Each (item, entry) yields at most one hit. Deterministically ordered (item
// name, then entry key). An unrecognized item produces nothing.
export function crossCheckWeatherMeds(
  items: readonly WeatherMedInput[],
  exposure: WeatherExposure
): WeatherMedHit[] {
  const hits: WeatherMedHit[] = [];
  for (const item of items) {
    for (const entry of entriesForItem(item, exposure)) {
      hits.push({
        itemId: item.id,
        itemName: item.name,
        exposure,
        entryKey: entry.key,
        label: entry.label,
        clause: entry.clause,
        note: entry.note,
        citation: entry.source,
      });
    }
  }
  return hits.sort(
    (a, b) =>
      a.itemName.localeCompare(b.itemName) ||
      a.entryKey.localeCompare(b.entryKey)
  );
}

// ---- Composition 1: enrich the existing UV line ------------------------------------

// How many item names an enriched clause will name before it collapses to a count. Two
// is the readable ceiling for a clause that is riding on the end of another sentence.
export const ENRICH_NAME_LIMIT = 2;

// The trailing clause for an existing line, or null when nothing matched. "note:
// doxycycline increases sun sensitivity" — the item's OWN name (what the user typed, so
// they recognize it) plus the class fact. Several matches collapse rather than listing:
// the line being enriched is the subject, this is a footnote to it.
export function weatherMedClause(
  hits: readonly WeatherMedHit[]
): string | null {
  if (hits.length === 0) return null;
  // De-duplicate by item: one item matching two entries says its name once.
  const byItem = new Map<number, WeatherMedHit>();
  for (const h of hits) if (!byItem.has(h.itemId)) byItem.set(h.itemId, h);
  const unique = [...byItem.values()];
  if (unique.length === 1) {
    return `note: ${unique[0].itemName} ${unique[0].clause}`;
  }
  if (unique.length <= ENRICH_NAME_LIMIT) {
    const names = unique.map((h) => h.itemName).join(" and ");
    return `note: ${names} ${unique[0].clause}`;
  }
  return `note: ${unique.length} of your active items ${unique[0].clause}`;
}

// Fold the clause into an existing detail string — ONE enriched line, never a second
// warning (the #1727 boundary). Returns the detail unchanged when nothing matched.
export function enrichUvDetail(
  detail: string,
  hits: readonly WeatherMedHit[]
): string {
  const clause = weatherMedClause(hits);
  if (!clause) return detail;
  const base = detail.trimEnd();
  const sep = base.endsWith(".") ? " " : " — ";
  return `${base}${sep}${clause.charAt(0).toUpperCase()}${clause.slice(1)}.`;
}

// ---- Composition 2: the standalone calm line ---------------------------------------

// A high-UV day: the day's peak UV index at or above this. UV 6 is the top of the
// "moderate" band and the point at which public guidance starts recommending
// protection — conservative enough that a photosensitizer note is not a daily event in
// a sunny climate.
export const HIGH_UV_INDEX = 6;

export interface WeatherMedObservation {
  dedupeKey: string;
  title: string;
  detail: string;
}

// The standalone photosensitizer note for a HIGH-UV day, or null. Emits only when: the
// day's peak UV is known and high, a photosensitizer is active, AND the overexposure
// warning is NOT already firing (when it is, the fact rides that line instead — one
// line, not two, about the same afternoon).
export function decidePhotosensitizerNote(
  date: string,
  input: {
    peakUvIndex: number | null;
    hits: readonly WeatherMedHit[];
    overexposureFiring: boolean;
  }
): WeatherMedObservation | null {
  const { peakUvIndex, hits, overexposureFiring } = input;
  if (overexposureFiring) return null;
  if (peakUvIndex == null || peakUvIndex < HIGH_UV_INDEX) return null;
  const hit = hits[0];
  if (!hit) return null;
  return {
    dedupeKey: weatherMedSignalKey(
      "photosensitizing",
      hit.itemId,
      hit.entryKey,
      date
    ),
    title: `Strong sun today, and ${hit.itemName} increases sun sensitivity`,
    detail:
      `UV reaches about ${Math.round(peakUvIndex)} today. ${hit.note} ` +
      `Shade, cover, or sunscreen is worth planning for if you'll be out. ` +
      `${GUARDRAIL} Source: ${hit.citation}.`,
  };
}

// The heat-risk note for a day the HEATWAVE situation holds, or null. Requires BOTH
// facts — the situation (which is itself several consecutive qualifying days, #1726)
// and a matching active item. No heatwave ⇒ nothing, however many diuretics are in the
// stack: a heat caution on a mild day is exactly the noise this composition avoids.
export function decideHeatRiskNote(
  date: string,
  input: {
    heatwaveActive: boolean;
    hits: readonly WeatherMedHit[];
    // The day's max temperature, already unit-formatted by the caller ("35°C"/"95°F"),
    // or null to render the note without a figure.
    tempLabel: string | null;
  }
): WeatherMedObservation | null {
  const { heatwaveActive, hits, tempLabel } = input;
  if (!heatwaveActive) return null;
  const hit = hits[0];
  if (!hit) return null;
  const heat = tempLabel ? `Today reaches ${tempLabel}` : "It's a hot spell";
  return {
    dedupeKey: weatherMedSignalKey("heat-risk", hit.itemId, hit.entryKey, date),
    title: `Hot spell, and ${hit.itemName} affects how you handle heat`,
    detail:
      `${heat}, and the heat has held for several days. ${hit.note} ` +
      `Keeping fluids up and staying out of peak-afternoon heat matters more than usual. ` +
      `${GUARDRAIL} Source: ${hit.citation}.`,
  };
}
