# Integrating with Epic MyChart — investigation

> **Status: partially superseded (2026-07).** This is the original
> investigation. **Path B shipped** and its description below is still
> accurate. **Path A is now designed in
> [`smart-on-fhir-spec.md`](./smart-on-fhir-spec.md)** (issue #143), which
> supersedes this doc's Path A recommendations where they differ:
>
> - **Public client + PKCE**, not a confidential client with a secret; one
>   **global client id** (Settings → Server), not per-profile credentials in
>   `integration_connections.config`.
> - Connections keyed **`smart-fhir:<endpointId>`** (multiple portals per
>   profile), not a single `epic` provider config.
> - Persistence via the **living-document model** (`persistHealthRecordDoc`
>   reprocess + canonicalized-bundle content hash), not direct row writes —
>   which also dissolves the "immunizations idempotency gap" below (document
>   import already handles immunizations).
> - The "no existing FHIR/SMART code" claim predates `lib/fhir/` and the
>   deterministic health-record import path; both exist now.
>
> The FHIR→schema mapping notes, sandbox guidance, endpoint-directory
> research, and Sources remain useful background.

## TL;DR

There are **two** ways to get a patient's data out of Epic/MyChart, at very different cost levels:

- **Path B — offline document import (no Epic account): the pragmatic path, shipped.** Two file formats, in order of preference:
  - **C-CDA / XDM (recommended — the complete record).** MyChart's **"Download Summary"** gives a `.zip`/`.xdm` (IHE XDM package) wrapping a **C-CDA CCD** XML — _every_ immunization (CVX-coded), lab, vital, and medication. We unwrap + parse it directly. This is the primary import.
  - **SMART Health Card (lighter secondary).** A signed JWS wrapping a small FHIR bundle a patient downloads/scans; convenient but usually **COVID-only**, so it's a fallback, not the main source.
    Both are decoded + mapped into our tables offline — no OAuth, no registration, no per-org endpoints.

- **Path A — SMART on FHIR "Connect MyChart" (live OAuth pull): the real thing, big lift.**
  Standard SMART standalone patient launch: the user picks their health system, logs into MyChart, authorizes read access, and we pull FHIR `Immunization` + lab `Observation` resources, with refresh-token background sync. Pulls the _full_ record but requires Epic app registration, multi-tenant endpoint discovery + org picker, and per-organization production enablement.

Recommendation: **Phase 1 = Path B, C-CDA/XDM first** (shipped; SMART Health Card as a convenience fallback), **Phase 2 = Path A** as a new `epic` OAuth provider once the offline mapping is proven.

---

## Path A — SMART on FHIR standalone patient launch (live pull)

**OAuth2 authorization-code flow (SMART App Launch v1/v2), with PKCE.**

1. **Register** the app on Epic on FHIR (fhir.epic.com → Connection Hub). You get a **non-production** and **production** `client_id`, set `redirect_uri`(s), and declare the patient-facing FHIR resources/scopes. Because this app has a **secure server backend**, register as a **confidential client** (Epic issues a client secret) — this is what unlocks **refresh tokens** for background re-sync. (A public client + PKCE also works but tends to short-lived access only.)

2. **Endpoint discovery + org picker.** Epic is multi-tenant: every health system has its own FHIR **base URL** and auth endpoints. Epic publishes a directory (SMART "User-access Brands" bundle of `Organization`/`Endpoint` resources) at **open.epic.com/MyApps/Endpoints** — download it periodically (~weekly) and re-host; do **not** query it at runtime. Show the user an **organization picker**; for the chosen org read `{fhirBase}/.well-known/smart-configuration` → `authorization_endpoint`, `token_endpoint`.

3. **Authorize** — redirect to the authorize endpoint:
   `response_type=code`, `client_id`, `redirect_uri`, `state`, `aud={fhirBase}`, PKCE `code_challenge` + `code_challenge_method=S256`, and
   `scope = openid fhirUser launch/patient patient/Immunization.read patient/Observation.read patient/Patient.read offline_access`
   (`launch/patient` establishes single-patient context; `offline_access` requests a refresh token; request the minimum for faster approval).

4. **Callback → token exchange** (server-side, confidential client secret + PKCE verifier) → `access_token`, `refresh_token`, and the **`patient`** FHIR id in the token response.

5. **Pull data** from `{fhirBase}` (FHIR R4):
   - `GET /Immunization?patient={id}` → map to our `immunizations` table.
   - `GET /Observation?patient={id}&category=laboratory` → map to `medical_records` (incl. antibody titers → feeds the immunity-titer aggregation).
   - (later: vital-signs Observations, Condition, DocumentReference, etc.)

6. **Background re-sync** per profile using the `refresh_token` — same shape as the existing Strava pull provider; store tokens in `integration_connections.config`.

### FHIR → our schema mapping

**`Immunization` → `immunizations`**

- `vaccineCode` — CVX code (`system http://hl7.org/fhir/sid/cvx`) + text. Map **CVX → our catalog `code`** (e.g. 08→hepb, 03/03=MMR→mmr, 115→tdap, 187→zoster, 140/141/150/158→influenza, 213→covid, 20→dtap, 10→ipv, 48→hib, 133→pcv, 21→varicella, 83/84/85→hepa, 62/165→hpv, 114→menacwy, …). Fall back to `normalizeVaccineName(text)` then slug.
- `occurrenceDateTime` → `date`; `status` — import only `completed` (skip `not-done`/`entered-in-error`); `lotNumber`/`protocolApplied.doseNumber` → `dose_label`/`notes`; `primarySource` → provenance note.
- **Idempotency:** dedup on the FHIR resource id → store as `external_id`/source `epic:{id}`; never touch manual rows (source NULL). (Mirrors Health-Connect ingest rules.)

**`Observation` (labs) → `medical_records`**

- `code` — LOINC + text → `name`/`canonical_name` (map common titer LOINCs, e.g. anti-HBs 16935-9). `valueQuantity` → `value_num`+`unit`; `valueString`/`valueCodeableConcept` ("Immune"/"Reactive") → `value` (drives `titerImmuneStatus`); `effectiveDateTime` → `date`; `referenceRange` → `reference_range`; `interpretation` H/L → `flag`.

### Cost / caveats

- **Multi-tenant endpoint discovery + org picker** is the biggest eng/UX cost.
- **Production go-live** requires Epic's app review + security attestation, and **each health system must enable your app** for its MyChart. Many auto-allow patient-facing apps registered on fhir.epic.com; some require org approval. Heavy for a self-hosted personal app.
- **Client secret** lives on the user's own server — fine here (admin-only global settings already hold provider secrets), but each self-hosted deploy would register its own Epic `client_id`.
- **Sandbox first:** fhir.epic.com sandbox with non-prod client_id + test patients (Camila Lopez, Derrick Lin, etc.) to build without real credentials.

---

## Path B — offline document import (implemented)

The "Import from MyChart" control on `/immunizations` auto-detects the format and routes to the right parser. Everything is offline, deduped on `external_id`, and doses share the catalog `vaccine` codes so they light up the schedule grid.

### B.1 — C-CDA / XDM (primary — the complete record)

MyChart's **"Download Summary" / "Download My Record"** produces `HealthSummary_<date>.zip` → `MachineReadable_XDMFormat/IHE_XDM/<name>/DOC0001.XML`. That `DOC0001.XML` is a **C-CDA CCD** — the _complete_ record (every immunization with CVX codes, plus labs, vitals, and medications). **XDM** is just the IHE **ZIP packaging** around the CCD (some portals hand you a `.xdm` file — same zip).

- `lib/zip.ts` — a dependency-free ZIP reader unwraps the `.zip`/`.xdm` and picks the CCD.
- `lib/cda/` — parses the CCD with `fast-xml-parser` and an **extensible extractor seam** (see below): Immunizations (LOINC 11369-6; CVX → catalog via `cvx-map`), Results (30954-2), Vital Signs (8716-3), and Medications (10160-0) ship as built-in extractors. Rows are deduped on `external_id` (source `ccda`); labs feed the immunity-titer aggregation. (Since split from a single `lib/cda.ts` into the `lib/cda/` module directory — `parse.ts` / `extractors.ts` / `normalize.ts` / …)

**Extensibility.** `lib/cda/` exposes `parseCcdaDocument(xml)` (raw sections) and a `SectionExtractor` registry (`DEFAULT_EXTRACTORS`). A new clinical section is one `SectionExtractor` appended to the list — no change to the walker or the writer, since every record flows through the common `ImportedRecord { category, … }` shape. The built-in **medications** extractor already lands prescriptions in `medical_records` (category `prescription`), the interim "structured home" for structured medications; when a dedicated medications table ships, only that sink changes.

### B.2 — SMART Health Card (secondary — usually COVID-only)

A **SMART Health Card** is a signed **JWS** whose payload is a raw-DEFLATE-compressed FHIR bundle, downloaded/scanned from MyChart as a QR or `.smart-health-card` file (chunked across QRs when large). `lib/smart-health-card.ts` decodes it (numeric `shc:/` → JWS → inflate → bundle) and dispatches each resource by `resourceType` (Immunization, Observation today; MedicationStatement/Condition are one mapper away) into the same shapes. Convenient, but coverage is issuer-dependent (historically **COVID-19 only**), so it's a fallback, not the primary source. Signature verification against the issuer JWKS is a documented follow-up.

---

## How it maps onto THIS codebase

The app already has a clean **declarative integrations layer** with a `push` provider (Health Connect) and an `oauth` provider (**Strava**). Epic is an `oauth` provider and follows the **Strava blueprint** end-to-end. There is **no existing FHIR/SMART/PKCE/Epic code** — we build the FHIR client from scratch, but every DB/UI/config primitive already exists. Secrets are stored **per-profile inside `integration_connections.config` JSON** (not global env), so a self-hosted user pastes their own Epic `client_id`/secret in the provider page — no shared credentials.

**Reuse (Strava is the template):**

- `lib/integrations/connections.ts` — add an `EpicConfig` block mirroring `StravaConfig`: `getEpicConfig/patchEpicConfig`, single-use `setEpicOAuthState`/`takeEpicOAuthState` (per-profile CSRF), `setEpicTokens`, and **`getEpicAccessToken()` with the refresh-token pattern already implemented for Strava** (`connections.ts:250-287` refreshes when <5 min to expiry). Add the SMART-specific fields: `codeVerifier`, `fhirBaseUrl` (Epic is multi-tenant — the org's `iss`), `patientId` (from the token response's `patient`), `authorizeUrl`/`tokenUrl` (from discovery).
- **Authorize action** — mirror `app/(app)/integrations/strava/actions.ts` `connectStrava()`, but generate a PKCE `code_verifier`, derive the S256 `code_challenge`, store the verifier with the state, and add `code_challenge`/`code_challenge_method=S256` + `aud={fhirBaseUrl}` to the params. (Strava's flow has **no PKCE** — this is the one genuinely new auth mechanic.)
- **Callback** — mirror `app/api/integrations/strava/callback/route.ts`: `getCurrentSession()` binds the profile (not middleware-allowlisted — the SameSite=Lax cookie rides the redirect), single-use `state` with `crypto.timingSafeEqual`, then POST `grant_type=authorization_code` + `code_verifier` to the **discovered** token endpoint.
- **Redirect URI** — mirror `app/(app)/integrations/strava/url.ts` → `epicCallbackUrl()` from `getPublicUrl()`; the provider page's SetupCard displays it for the user to pre-register on Epic.
- **Scheduled sync** — add a per-profile `runEpicSync(profileId)` block in `scripts/notify.ts` next to the Strava one; keep it free of request-scoped APIs (no `revalidatePath`), like `strava-sync.ts`.
- **Writing data** — reuse `upsertVitals(profileId, rows, "epic")` in `lib/integrations/normalize.ts` for lab Observations → `medical_records` (idempotent on `external_id`, never touches manual rows), then `addCanonicalNames` + `reconcileFlags` (the Health-Connect ingest caller pattern).

**The one real gap — immunizations idempotency.** The `immunizations` table has **no `external_id` column** and a **non-unique** `(profile_id, vaccine, date)` index, and there's **no upsert helper** (manual/extract paths just INSERT). For repeatable Epic sync we need:

1. `lib/db.ts` — add `immunizations.external_id TEXT` + a partial-unique index `(profile_id, external_id) WHERE external_id IS NOT NULL` (the exact `addColumnIfMissing` + `CREATE UNIQUE INDEX` pattern already used for `medical_records`/`activities`).
2. `lib/integrations/normalize.ts` — a `NormImmunization` shape + `upsertImmunizations(profileId, rows, "epic")` mirroring `upsertVitals` (find by `external_id`; never touch NULL-external rows).
3. Map FHIR `Immunization.vaccineCode` (CVX) → our catalog `code` via `codeFor()`/`normalizeVaccineName` in `lib/immunization-catalog.ts`, so Epic rows share the same `vaccine` codes as manual/document/extraction rows and light up the same schedule grid. `source: "epic"`, `external_id: "epic:<Immunization.id>"`.

**Build checklist (Phase A, mirrors existing patterns):**

1. `lib/types.ts` — add `"epic"` to `IntegrationId`.
2. `lib/integrations/registry.ts` — add the `epic` `IntegrationDef` (auto-adds the Integrations card); update `lib/__tests__/registry.test.ts`.
3. `lib/integrations/connections.ts` — `EpicConfig` + helpers (above).
4. `lib/integrations/epic.ts` — SMART discovery (`/.well-known/smart-configuration`), FHIR fetch with `Bundle` pagination (`Immunization?patient=`, `Observation?patient=&category=laboratory`), CVX→catalog + LOINC→canonical mappers.
5. `lib/integrations/normalize.ts` — `NormImmunization` + `upsertImmunizations`.
6. `lib/db.ts` — `immunizations.external_id` + partial-unique index.
7. `lib/integrations/epic-sync.ts` — `runEpicSync(profileId)` (transaction → `addCanonicalNames`/`reconcileFlags` → `recordSync`).
8. `app/(app)/integrations/epic/{url.ts, actions.ts, page.tsx}` + `app/api/integrations/epic/callback/route.ts`.
9. `scripts/notify.ts` — per-profile `runEpicSync` block.

Pure, testable pieces (fit the repo's "logic in `lib/`, tested in `lib/__tests__`" rule): CVX→code and LOINC→canonical maps, the FHIR→`Norm*` mappers, the SHC JWS decoder (Path B), and PKCE challenge derivation.

## Sources

- [Epic on FHIR — Home](https://fhir.epic.com/) · [Documentation](https://fhir.epic.com/Documentation) · [FAQ](https://fhir.epic.com/FAQ)
- [open.epic — Patient Authentication (MyChart)](https://open.epic.com/Tutorial/PatientAuthentication?whereFrom=MyChart) · [Endpoints directory](https://open.epic.com/MyApps/Endpoints)
- [SMART App Launch — scopes & launch context (HL7)](https://build.fhir.org/ig/HL7/smart-app-launch/scopes-and-launch-context.html)
- [SMART Health Cards Framework spec](https://spec.smarthealth.cards/) · [smart-on-fhir/health-cards](https://github.com/smart-on-fhir/health-cards/blob/main/docs/index.md)
- Practical guides: [Medblocks — Patient app on Epic](https://medblocks.com/blog/patient-app-integration-with-smart-on-epic-how-to-guide-the-fundamentals), [6B — register/authenticate/launch](https://6b.health/insight/how-to-register-authenticate-launch-apps-with-epics-fhir-apis/), [Consolidate Health — Epic FHIR access](<https://consolidate.health/blog/how-to-access-patient-records-from-epic-s-fhir-api-(without-the-headache)>)
  </content>
