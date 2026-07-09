import { parseXdm, parseCcda, looksLikeCda, xdmContainsCda } from "./cda";
import { parseSmartHealthCard } from "./smart-health-card";
import { parseFhirBundle } from "./fhir";
import { isZip } from "./zip";
import type { ImportResult } from "./health-import";

// Format sniffing + parse dispatch for portal health-record files — a MyChart
// "Download Summary" (IHE XDM .zip/.xdm or its C-CDA/CCD XML), a SMART Health
// Card, or a raw FHIR R4 bundle (Epic SMART-on-FHIR / Apple Health export). Kept
// free of any DB dependency so it stays pure and unit-testable; the persistence
// bridge lives in lib/health-record-doc.

export type HealthRecordKind = "xdm" | "cda" | "shc" | "fhir";

// Sniff a stored/uploaded buffer for a supported health-record format, so both
// the upload router and the reprocess path can tell a CCD/XDM/SHC/FHIR apart from
// an AI-extractable document (PDF/image/CSV) without a filename to trust.
export function detectHealthRecord(buffer: Buffer): HealthRecordKind | null {
  // A ZIP is only an XDM health record if it actually holds a CCD/CDA — .xlsx /
  // .docx are ZIPs too, and must fall through to AI extraction, not the XDM path.
  if (isZip(buffer)) return xdmContainsCda(buffer) ? "xdm" : null;
  const head = buffer.toString("utf8", 0, 4000);
  if (looksLikeCda(head)) return "cda";
  if (/shc:\//i.test(head)) return "shc";
  if (head.trim().startsWith("{")) {
    // A .smart-health-card file wraps the JWS(es); a raw FHIR export is a Bundle.
    if (/verifiableCredential/.test(head)) return "shc";
    if (/"resourceType"\s*:\s*"Bundle"/.test(head)) return "fhir";
  }
  // A bare compact JWS (header.payload.signature) is a SMART Health Card too.
  // Test the whole (trimmed) buffer, not just the 4000-char head: a JWS carries
  // a base64url payload with no whitespace, so a card larger than the head window
  // would fail the anchored match and be misrouted. Bounded to keep it cheap.
  if (buffer.length <= 1_000_000) {
    const full = buffer.toString("utf8").trim();
    if (/^[\w-]+\.[\w-]+\.[\w-]+$/.test(full)) return "shc";
  }
  return null;
}

// Parse a detected health-record buffer into the shared ImportResult, tagging the
// provenance source. Throws the format's own error (CdaError / ZipError /
// SmartHealthCardError / FhirError) on bad input, or a generic Error when
// unrecognized.
export function parseHealthRecord(buffer: Buffer): {
  parsed: ImportResult;
  source: string;
} {
  const kind = detectHealthRecord(buffer);
  if (kind === "xdm") return { parsed: parseXdm(buffer), source: "ccda" };
  const text = buffer.toString("utf8");
  if (kind === "cda") return { parsed: parseCcda(text), source: "ccda" };
  if (kind === "shc")
    return { parsed: parseSmartHealthCard(text), source: "smart-health-card" };
  if (kind === "fhir") return { parsed: parseFhirBundle(text), source: "fhir" };
  throw new Error(
    "Not a recognized health record (expected a CCD/CDA XML, XDM zip, SMART Health Card, or FHIR bundle)."
  );
}
