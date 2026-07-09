import { normalizeVaccineName, slugifyVaccine } from "./immunization-catalog";

// Maps FHIR/CDC CVX vaccine codes to this app's catalog codes (lib/immunization
// -catalog). CVX is the standard code system used in FHIR Immunization.vaccineCode
// (system http://hl7.org/fhir/sid/cvx) and on SMART Health Cards, so mapping it
// lets imported doses share the same `vaccine` codes — and the same schedule
// grid — as manually entered ones. Combination CVX codes map to the combo code
// (which the status engine expands to its component series).
//
// This is a practical subset covering the catalog; unknown CVX codes fall back
// to the vaccineCode text via normalizeVaccineName, then a slug (never dropped).
// Reference: CDC CVX code set (cdc.gov/vaccines/programs/iis/code-sets.html).

export const CVX_TO_CODE: Record<string, string> = {
  // Hepatitis B (+ combos)
  "08": "hepb",
  "42": "hepb",
  "43": "hepb",
  "44": "hepb",
  "45": "hepb",
  "189": "hepb",
  "220": "hepb",
  // Hepatitis A
  "52": "hepa",
  "83": "hepa",
  "84": "hepa",
  "85": "hepa",
  "31": "hepa",
  "104": "twinrix", // 104 = HepA-HepB (Twinrix)
  // DTaP / Td / Tdap (+ combos)
  "20": "dtap",
  "106": "dtap",
  "107": "dtap",
  "50": "dtap",
  "01": "dtap",
  "110": "pediarix", // DTaP-HepB-IPV
  "120": "pentacel", // DTaP-IPV/Hib
  "130": "kinrix", // DTaP-IPV (Kinrix/Quadracel)
  "146": "vaxelis", // DTaP-IPV-Hib-HepB
  "115": "tdap",
  "09": "tdap",
  "113": "tdap",
  "138": "tdap",
  "139": "tdap",
  "196": "tdap",
  // Hib
  "17": "hib",
  "46": "hib",
  "47": "hib",
  "48": "hib",
  "49": "hib",
  "51": "hib",
  // Polio (IPV)
  "10": "ipv",
  "89": "ipv",
  "02": "ipv",
  // Pneumococcal conjugate (childhood) vs polysaccharide (adult)
  "100": "pcv",
  "133": "pcv",
  "152": "pcv",
  "215": "pcv",
  "216": "pcv",
  "33": "pneumo_adult",
  "109": "pneumo_adult",
  // MMR / MMRV / measles-mumps-rubella singles
  "03": "mmr",
  "04": "mmr",
  "05": "mmr",
  "06": "mmr",
  "07": "mmr",
  "38": "mmr",
  "94": "proquad", // MMRV
  // Varicella
  "21": "varicella",
  // Influenza (broad — many CVX)
  "15": "influenza",
  "16": "influenza",
  "88": "influenza",
  "111": "influenza",
  "135": "influenza",
  "140": "influenza",
  "141": "influenza",
  "144": "influenza",
  "149": "influenza",
  "150": "influenza",
  "153": "influenza",
  "155": "influenza",
  "158": "influenza",
  "161": "influenza",
  "166": "influenza",
  "168": "influenza",
  "171": "influenza",
  "185": "influenza",
  "186": "influenza",
  "197": "influenza",
  "205": "influenza",
  "231": "influenza",
  "232": "influenza",
  // COVID-19 (broad)
  "207": "covid",
  "208": "covid",
  "210": "covid",
  "211": "covid",
  "212": "covid",
  "213": "covid",
  "217": "covid",
  "218": "covid",
  "219": "covid",
  "221": "covid",
  "225": "covid",
  "226": "covid",
  "227": "covid",
  "228": "covid",
  "229": "covid",
  "230": "covid",
  "300": "covid",
  "301": "covid",
  "302": "covid",
  "308": "covid",
  "309": "covid",
  "310": "covid",
  "311": "covid",
  "312": "covid",
  "313": "covid",
  // Zoster
  "121": "zoster",
  "187": "zoster",
  "188": "zoster",
  // HPV
  "62": "hpv",
  "118": "hpv",
  "137": "hpv",
  "165": "hpv",
  // Meningococcal
  "114": "menacwy",
  "136": "menacwy",
  "147": "menacwy",
  "167": "menacwy",
  "203": "menacwy",
  "162": "menb",
  "163": "menb",
  "164": "menb",
  // Rotavirus
  "116": "rv",
  "119": "rv",
  "122": "rv",
  // RSV
  "303": "rsv",
  "304": "rsv",
  "305": "rsv",
  "306": "rsv",
  "307": "rsv",
  // Travel / non-routine
  "37": "yellow_fever",
  "183": "yellow_fever",
  "184": "yellow_fever",
  "25": "typhoid",
  "41": "typhoid",
  "53": "typhoid",
  "91": "typhoid",
  "101": "typhoid",
  "18": "rabies",
  "40": "rabies",
  "90": "rabies",
  "175": "rabies",
  "176": "rabies",
  "19": "bcg",
  "39": "je",
  "129": "je",
  "134": "je",
  "26": "cholera",
  "172": "cholera",
  "174": "cholera",
  "75": "mpox",
  "105": "mpox",
  "206": "mpox",
};

// A minimal FHIR CodeableConcept shape (only what we read).
export interface FhirCodeableConcept {
  coding?: { system?: string; code?: string; display?: string }[];
  text?: string;
}

const CVX_SYSTEMS = [
  "http://hl7.org/fhir/sid/cvx",
  "urn:oid:2.16.840.1.113883.12.292", // CVX OID
];

// Resolve a FHIR Immunization.vaccineCode to a catalog/combo code: try the CVX
// coding first, then any coding's display text, then the concept text — each via
// the catalog matcher. Returns null only when nothing is present (caller slugs).
export function codeFromVaccineCode(
  vc: FhirCodeableConcept | null | undefined
): string | null {
  if (!vc) return null;
  for (const c of vc.coding ?? []) {
    if (c.code && c.system && CVX_SYSTEMS.includes(c.system)) {
      const mapped = CVX_TO_CODE[c.code.trim()];
      if (mapped) return mapped;
    }
  }
  // Fall back to display/text via the name matcher.
  for (const c of vc.coding ?? []) {
    const byDisplay = c.display && normalizeVaccineName(c.display);
    if (byDisplay) return byDisplay;
  }
  const byText = vc.text && normalizeVaccineName(vc.text);
  if (byText) return byText;
  // Last resort: slug a display/text so the dose still lands (uncredited).
  const raw = vc.text || vc.coding?.find((c) => c.display)?.display || "";
  return raw ? slugifyVaccine(raw) : null;
}
