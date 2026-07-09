import zlib from "node:zlib";
import { resourcesToImportResult } from "./fhir";
import type { ImportResult } from "./health-import";

// Decode a SMART Health Card (the QR / .smart-health-card file a patient
// downloads from a portal) into its FHIR bundle, then hand the resources to the
// shared FHIR mapper (lib/fhir). A card is a JWS whose payload is a raw-DEFLATE-
// compressed FHIR bundle; this module owns only the decoding — the resource →
// record mapping is shared with the raw-FHIR importer. No OAuth, no network, so
// this whole module is pure and unit-tested.
//
// Signature verification (against the issuer's published JWKS) is intentionally
// NOT done here — we import the user's own card and mark provenance
// "smart-health-card"; verification is a follow-up.

export interface ShcResult extends ImportResult {
  issuer: string | null;
}

export class SmartHealthCardError extends Error {}

// --- decoding ---

// "shc:/" numeric encoding: each pair of digits is a char code offset by 45.
function numericToJws(numeric: string): string {
  if (numeric.length % 2 !== 0)
    throw new SmartHealthCardError("Malformed SMART Health Card QR payload.");
  let out = "";
  for (let i = 0; i < numeric.length; i += 2) {
    const n = parseInt(numeric.slice(i, i + 2), 10);
    if (Number.isNaN(n))
      throw new SmartHealthCardError("Malformed SMART Health Card QR payload.");
    out += String.fromCharCode(n + 45);
  }
  return out;
}

// Reassemble one or more `shc:/…` QR segments (single or multi-chunk) into JWS.
function jwsFromShcSegments(segments: string[]): string {
  const chunks: { index: number; numeric: string }[] = [];
  let count = 1;
  for (const seg of segments) {
    const m = /^shc:\/(?:(\d+)\/(\d+)\/)?([\d]+)$/i.exec(seg.trim());
    if (!m)
      throw new SmartHealthCardError("Unrecognized SMART Health Card QR code.");
    const index = m[1] ? parseInt(m[1], 10) : 1;
    if (m[2]) count = parseInt(m[2], 10);
    chunks.push({ index, numeric: m[3] });
  }
  chunks.sort((a, b) => a.index - b.index);
  if (chunks.length !== count)
    throw new SmartHealthCardError(
      `Incomplete SMART Health Card: got ${chunks.length} of ${count} QR chunks.`
    );
  return numericToJws(chunks.map((c) => c.numeric).join(""));
}

// Pull the JWS string(s) out of any accepted input: a .smart-health-card file
// (JSON with verifiableCredential[]), one or more shc:/ QR payloads, or a bare JWS.
function extractJwsList(input: string): string[] {
  const s = input.trim();
  if (!s) throw new SmartHealthCardError("No SMART Health Card provided.");

  if (s.startsWith("{")) {
    let obj: any;
    try {
      obj = JSON.parse(s);
    } catch {
      throw new SmartHealthCardError(
        "Invalid .smart-health-card file (bad JSON)."
      );
    }
    const vc = obj?.verifiableCredential;
    if (Array.isArray(vc) && vc.every((x) => typeof x === "string")) return vc;
    throw new SmartHealthCardError(
      "File is not a SMART Health Card (missing verifiableCredential)."
    );
  }

  if (/shc:\//i.test(s)) {
    const segments = s.split(/\s+/).filter((x) => /^shc:\//i.test(x));
    if (segments.length === 0)
      throw new SmartHealthCardError("Unrecognized SMART Health Card QR code.");
    return [jwsFromShcSegments(segments)];
  }

  // Bare JWS (header.payload.signature).
  if (s.split(".").length === 3) return [s];

  throw new SmartHealthCardError("Unrecognized SMART Health Card format.");
}

// Hard cap on the decompressed payload. A real card's FHIR bundle is a few KB;
// this bounds an attacker-crafted raw-DEFLATE bomb so inflate throws (and we
// fall through) instead of allocating gigabytes and OOM-killing the process.
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

// Decompress a JWS payload segment to its FHIR bundle. SMART Health Cards use
// raw DEFLATE; fall back to zlib and then plain JSON for lenient inputs.
function inflatePayload(segment: string): string {
  const raw = Buffer.from(segment, "base64url");
  for (const fn of [zlib.inflateRawSync, zlib.inflateSync]) {
    try {
      return fn(raw, { maxOutputLength: MAX_PAYLOAD_BYTES }).toString("utf8");
    } catch {
      /* try next */
    }
  }
  if (raw.length > MAX_PAYLOAD_BYTES)
    throw new SmartHealthCardError("SMART Health Card payload is too large.");
  return raw.toString("utf8"); // uncompressed fallback
}

interface DecodedCard {
  issuer: string | null;
  bundle: any;
}

function decodeJws(jws: string): DecodedCard {
  const parts = jws.split(".");
  if (parts.length !== 3)
    throw new SmartHealthCardError("Malformed SMART Health Card (not a JWS).");
  let payload: any;
  try {
    payload = JSON.parse(inflatePayload(parts[1]));
  } catch {
    throw new SmartHealthCardError(
      "Could not decode the SMART Health Card payload."
    );
  }
  const bundle = payload?.vc?.credentialSubject?.fhirBundle;
  if (!bundle || bundle.resourceType !== "Bundle")
    throw new SmartHealthCardError(
      "SMART Health Card contains no FHIR bundle."
    );
  return {
    issuer: typeof payload.iss === "string" ? payload.iss : null,
    bundle,
  };
}

// Decode every credential in the input into its FHIR bundle (+ issuer).
export function decodeSmartHealthCard(input: string): DecodedCard[] {
  return extractJwsList(input).map(decodeJws);
}

// --- mapping ---

// Decode a card (any accepted form), flatten every card's bundle, and hand the
// resources to the shared FHIR mapper (tagging provenance "smart-health-card").
export function parseSmartHealthCard(input: string): ShcResult {
  const cards = decodeSmartHealthCard(input);
  let issuer: string | null = null;
  const resources: any[] = [];
  for (const card of cards) {
    if (!issuer) issuer = card.issuer;
    for (const entry of card.bundle?.entry ?? [])
      resources.push(entry?.resource);
  }
  const result = resourcesToImportResult(resources, "smart-health-card");
  return { issuer, ...result };
}
