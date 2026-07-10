# Spec: Mobile companion app (Capacitor shell)

Status: **draft** · Owner: TBD · Tracking issue: [#174](https://github.com/FloorLamp/allos/issues/174)

## Problem

There is no native mobile presence. The PWA is mature (service worker,
standalone manifest, offline write queue with exactly-once replay, web push)
and covers most day-to-day use, but it has a hard ceiling: **a PWA cannot
read HealthKit**, so iOS health data depends on a third-party exporter app
(#141), and there's no biometric app lock, native share-in, or app-store
discoverability.

## Decision (recorded with its rejected alternative)

**Build a thin Capacitor shell around the existing server-rendered web app**
— the Home Assistant / Nextcloud companion model — and **do not build a
true native / React Native client.**

The argument against native is structural, not aesthetic: this app has **no
API**. Writes are Server Actions, reads are Server Components; there is no
JSON surface a native client can consume. A native app therefore means
designing, securing (token auth beside cookie sessions), and _permanently
versioning_ a REST/RPC layer across every domain — then living with the
store-app-vs-any-server-version compatibility matrix that plagues
self-hosted companions with real APIs. That is a second product. The shell
model instead renders the server's own UI, so:

- **No API layer** is needed — Server Actions work as-is inside the WebView.
- **No version skew** — upgrading the Docker image upgrades the app's UI;
  the shell version only matters for its small native-bridge surface.
- One maintainer can sustain it.

The PWA remains fully supported; the shell is additive. Anything that lands
as a web feature is automatically in the app.

## Goals (v1)

1. **HealthKit exporter** — the headline feature. The shell reads HealthKit
   and POSTs to the Apple Health ingest endpoint (#141), replacing the
   third-party exporter dependency and completing the iOS ingestion story.
2. **Biometric app lock** — Face ID / fingerprint gate in front of the
   WebView (real value: on-device PHI).
3. **Share-in** — receive a PDF/image from the iOS/Android share sheet and
   hand it to the document-import upload flow.
4. **Server-URL onboarding** — first launch asks for the instance URL
   (standard for self-hosted companions), validates via `/api/health`, then
   loads the normal login page.

### Non-goals (v1)

- **No native push.** APNs/FCM require the _publisher's_ keys, which a
  self-hosted server doesn't hold; every self-hosted companion solves this
  with a hosted encrypted relay (Home Assistant runs one) — infrastructure
  plus a privacy tension this project doesn't need yet. Telegram + web push
  already cover reminders. Revisit only on demand, as a separate spec.
- **No native UI screens** beyond onboarding/lock — everything else is the
  server's pages. No offline-first native cache beyond what the existing
  service worker provides.
- **No Android Health Connect bridge in v1** — Android already has a
  working exporter path (the HC push integration); fold it into the shell
  later only if the third-party exporter becomes a liability.
- **No tablet/desktop targets.**

## Architecture

```
mobile/                      # Capacitor project, same monorepo
  app/                       # shell source (TS): onboarding, lock, bridges
  ios/  android/             # generated platform projects
```

Monorepo placement keeps the shell versioned next to the ingest contracts
it depends on; it has its own build (Xcode/Gradle via Capacitor CLI) and is
excluded from the web app's `tsc`/vitest/e2e gates. A `mobile/README.md`
documents the build; CI can lint/typecheck `mobile/app` cheaply, but store
builds stay manual (signing).

### Shell behavior

- **Onboarding:** enter/scan server URL → `GET <url>/api/health` to
  validate reachability (the endpoint is public and body-coarse by design)
  → persist URL in native storage → load the site. HTTPS required; plain
  HTTP allowed only for RFC1918/localhost addresses (LAN-only deployments),
  with a warning.
- **Auth:** the WebView uses the app's normal cookie session (Capacitor
  WebViews persist cookies). No token scheme, no session changes
  server-side. Logout/login are the web flows.
- **Biometric lock:** optional (default on), gates app foregrounding after
  a configurable grace period. Purely local — wraps the WebView, never
  talks to the server. Uses the standard Capacitor biometric plugin.
- **Share-in:** share-sheet registration for PDF/images → the shell opens
  `<server>/medical?upload=1` (or the Data → Import tab) and injects the
  file into the existing upload input via the Capacitor share plugin's
  file handoff. No new server endpoint — the existing upload action is the
  contract.
- **External links** (docs, Strava/SMART OAuth pages) open in the system
  browser / `ASWebAuthenticationSession`, not the WebView — OAuth
  callbacks then deep-link back via a registered URL scheme. **Caveat:**
  the Strava and SMART callbacks are session-gated; opening them in the
  system browser breaks the cookie continuity, so OAuth connect flows in
  the shell either (a) stay inside the WebView (acceptable: it's a real
  browser context), or (b) are documented as desktop tasks in v1. Decide
  during PR 1 with a real device; (a) is the expected answer.

### HealthKit exporter bridge

The shell is _an exporter client_ of the #141 ingest endpoint — same
contract, same guards, nothing server-side is shell-specific:

- **Setup:** the profile's ingest token (per-profile issuance UI from #141)
  is entered/scanned once in the shell's settings; stored in the iOS
  Keychain.
- **Read:** HKObserverQuery + background delivery for the mapped types
  (weight, body fat, steps, HR, sleep, workouts, BP, glucose, SpO2, VO2
  max) over a rolling 48h window — mirroring the HC exporter's shape so the
  server-side idempotency assumptions (natural-key upserts, rolling-window
  resends) hold unchanged.
- **Push:** POST JSON to `/api/integrations/apple-health/ingest` with the
  bearer token; respect the 2MB cap by chunking days. Failures queue and
  retry on next background wake — the endpoint's idempotency makes
  duplicate delivery safe (#141's design).
- iOS background execution is best-effort; the shell also syncs on every
  foreground. Set expectations in UI copy ("syncs when opened; background
  sync when iOS allows").

**Sequencing: this bridge depends on #141 (the ingest endpoint + parser)
landing first.** The shell's v1 can ship before #141 with the bridge dark,
but there's little point — schedule #141 → shell.

## Distribution

- **iOS:** App Store (a self-hosted companion is well-precedented — Immich,
  Home Assistant, Nextcloud all pass review). Health-data review needs a
  privacy policy stating data goes only to the user's own server; the
  HealthKit entitlement usage strings must say the same. TestFlight for
  betas.
- **Android:** Play Store + the APK attached to GitHub releases (the
  self-hosted crowd expects a store-free option).
- Store metadata/screenshots live in `mobile/fastlane/` when automated;
  manual at first.

## Security notes

- PHI at rest on device = WebView cache + service-worker storage, same as
  the PWA in mobile Safari/Chrome today; biometric lock is the added
  mitigation. No shell-side PHI database.
- The ingest token in Keychain is the only credential the shell itself
  holds; revocable server-side (existing token management).
- Certificate handling: system trust store only — no pinning (self-hosters
  use their own certs), no insecure-TLS override.

## Testing

- **Pure (existing tiers):** none of the server code changes; #141's tests
  cover the contract the shell consumes.
- **Shell unit:** onboarding URL validation, chunking/backoff logic for the
  exporter bridge (TypeScript, plain vitest inside `mobile/`).
- **Device matrix (manual, documented checklist):** iPhone (FaceID +
  TouchID), one Android; HealthKit permission flows, background delivery,
  share-in, OAuth-in-WebView, biometric re-lock.
- The web app's own e2e suite is untouched — the shell renders the same
  pages those tests already cover.

## Rollout

1. **PR 1 — walking skeleton:** Capacitor project, onboarding, WebView with
   cookie persistence, biometric lock. Sideloadable build; OAuth-in-WebView
   decision made on-device.
2. **PR 2 — HealthKit exporter bridge** (after #141): read/map/push +
   settings screen + retry queue. TestFlight beta.
3. **PR 3 — share-in + store submission:** share-sheet handoff, store
   metadata, privacy policy, release checklist (incl. Epic-sandbox-style
   manual gates for HealthKit flows).
4. **Later, each its own decision:** Android HC bridge, push relay,
   home-screen widgets, Apple Watch.

Estimated effort: **1.5–2 months** focused, dominated by platform plumbing
(signing, entitlements, background-delivery quirks) rather than app code.

## Open questions

1. **OAuth in WebView vs system browser** (see Shell behavior) — decide in
   PR 1 on hardware.
2. **Monorepo CI scope** — lint/typecheck `mobile/` in the existing `check`
   job vs a separate workflow; proposal: separate light workflow, so mobile
   churn never blocks server CI.
3. **Minimum OS versions** — proposal: iOS 16+ (web push parity), Android
   10+.
4. **QR pairing** — the server could render a QR (server URL + ingest
   token) on the integration page for one-scan setup; cheap, decide in
   PR 2.
