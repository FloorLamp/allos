// Generate lib/zip-centroids.json — a bundled, offline US ZIP (ZCTA) → coarse
// centroid table used to SUGGEST a per-profile home location from an imported
// CCD's patient postal code (issue #570), with zero runtime network access.
//
// WHY THIS EXISTS. Turning a street address into coordinates normally means
// geocoding through a third party — exactly the PHI leak (a provider address, a
// home address) the app is built to avoid. But the *ZIP code alone* resolves to a
// coarse area centroid, and the U.S. Census Bureau publishes ZCTA (ZIP Code
// Tabulation Area) centroids as a public-domain gazetteer. Bundling that table
// lets the CCD-import home-location suggestion run entirely offline, US-only
// (non-US postal codes stay manual), and — because we round to ~0.1° (~11 km) —
// at a precision that matches the deliberately-coarse `home_lat`/`home_lng`
// storage by construction. No street address is ever encoded.
//
// SOURCE. Census 2023 ZCTA national gazetteer (public domain):
//   https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip
// Tab-separated; columns GEOID (the 5-digit ZCTA), …, INTPTLAT, INTPTLONG (the
// internal-point latitude/longitude). We keep GEOID → [lat, lng] rounded to one
// decimal place.
//
// CONVENTION. Like the other gen:* datasets, the parsed result is COMMITTED to the
// repo (lib/zip-centroids.json) and read at runtime; the network fetch happens only
// here, at generation time (`npm run gen:zip-centroids`), never in the app or in
// CI. Unlike the small hand-curated datasets, this one is fetched (not inlined) and
// so is not covered by a fixed-point rebuild test — the committed JSON is the
// source of truth; re-run this script to refresh it against a newer gazetteer.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";

const GAZETTEER_URL =
  "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2023_Gazetteer/2023_Gaz_zcta_national.zip";

const OUT = path.join(process.cwd(), "lib", "zip-centroids.json");

// Round to 1 decimal place (~11 km) — the coarse storage precision. Keep it as a
// number (JSON has no fixed-point), so 18.2 stays 18.2.
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Parse the gazetteer TSV text into a zip → [lat, lng] map (rounded). Pure, so a
// test could feed it a fixture; exported for that reason.
export function parseGazetteer(tsv: string): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  const lines = tsv.split(/\r?\n/);
  // First line is the header (GEOID … INTPTLAT INTPTLONG).
  const header = lines[0].split("\t").map((h) => h.trim());
  const iGeo = header.indexOf("GEOID");
  const iLat = header.indexOf("INTPTLAT");
  const iLng = header.indexOf("INTPTLONG");
  if (iGeo < 0 || iLat < 0 || iLng < 0) {
    throw new Error(
      `unexpected gazetteer header (GEOID/INTPTLAT/INTPTLONG not found): ${header.join(",")}`
    );
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cols = line.split("\t");
    const zip = (cols[iGeo] ?? "").trim();
    const lat = Number((cols[iLat] ?? "").trim());
    const lng = Number((cols[iLng] ?? "").trim());
    if (!/^\d{5}$/.test(zip)) continue;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    out[zip] = [round1(lat), round1(lng)];
  }
  return out;
}

function fetchGazetteerTsv(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "zcta-"));
  const zipPath = path.join(tmp, "zcta.zip");
  // curl + unzip keeps this dependency-free (no zip lib); the file is ~1 MB.
  execFileSync("curl", [
    "-sSL",
    "--max-time",
    "120",
    "-o",
    zipPath,
    GAZETTEER_URL,
  ]);
  const out = execFileSync("unzip", ["-p", zipPath], {
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.toString("utf8");
}

function writeDataset(): void {
  const tsv = fetchGazetteerTsv();
  const map = parseGazetteer(tsv);
  const n = Object.keys(map).length;
  if (n < 30000) {
    throw new Error(`suspiciously few ZCTAs parsed (${n}); aborting`);
  }
  // Compact (single-line) JSON: ~33k rows pretty-printed would triple the file for
  // no benefit — this dataset is machine-read, not hand-diffed line by line.
  fs.writeFileSync(OUT, JSON.stringify(map) + "\n");
  // eslint-disable-next-line no-console
  console.log(`Wrote ${n} ZCTA centroids to ${OUT}`);
}

if (process.argv[1]?.includes("gen-zip-centroids")) {
  writeDataset();
}
