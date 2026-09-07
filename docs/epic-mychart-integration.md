# Importing MyChart records

Allos imports downloaded health-record files today. Direct SMART on FHIR OAuth
connections are planned in the [patient-access spec](smart-on-fhir-spec.md);
there is no shipped `epic` or `smart-fhir` connector.

## Import a file

1. Download a machine-readable health summary from your portal, when available.
2. Select the intended Allos profile, then open **Data → Import → File upload**.
   The immunizations page's **Import records** link opens the same destination.
3. Upload the export and review its coverage and imported records in
   **Data → Review**. Coverage depends on what the portal exported and what the
   parser supports; an export is not a guarantee of the complete chart.

Supported inputs are C-CDA/CCD XML, an XDM `.zip` or `.xdm` containing that XML,
a raw FHIR R4 Bundle, and SMART Health Card files or encoded text. ZIP files are
recognized as health records only when they contain CDA content. These formats
use deterministic parsing without an AI call.

SMART Health Cards use the same FHIR resource mappers as raw bundles. Allos
currently decodes their contents without verifying the issuer signature; an
imported card is not proof of issuer authenticity. See
[`lib/smart-health-card.ts`](../lib/smart-health-card.ts) for accepted encodings.

An upload becomes a managed medical document with provenance and an import
report. Re-importing that document replaces its imported rows through the
shared persistence path. For review, reprocessing, and deletion controls, use
the [import action guide](internals/import-actions.md).

## Code owners

| Responsibility                         | Owner                                                         |
| -------------------------------------- | ------------------------------------------------------------- |
| Format detection and dispatch          | [`lib/health-record-parse.ts`](../lib/health-record-parse.ts) |
| CDA sections and XDM extraction        | [`lib/cda/`](../lib/cda/)                                     |
| FHIR resource mapping and coverage     | [`lib/fhir/bundle.ts`](../lib/fhir/bundle.ts)                 |
| SMART Health Card decoding             | [`lib/smart-health-card.ts`](../lib/smart-health-card.ts)     |
| Parse-to-document bridge               | [`lib/health-record-doc.ts`](../lib/health-record-doc.ts)     |
| Shared document writes and replacement | [`lib/import-persist.ts`](../lib/import-persist.ts)           |

Extend these owners for additional record types. Keep source labels, vaccine
mapping, normalization, and document lifecycle in the shared import path.

The [integration guide](integrations.md#patient-portals) covers the separate,
shipped attended portal-acquisition workflow. The
[SMART spec](smart-on-fhir-spec.md) is the single design for future direct OAuth
pulls; it reuses this document import path.
