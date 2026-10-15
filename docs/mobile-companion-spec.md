# Spec: Mobile companion app (Capacitor shell)

Status: **draft** · Owner: TBD · Tracking issue:
[#174](https://github.com/FloorLamp/allos/issues/174)

## Problem

There is no native mobile presence. The PWA is mature (service worker,
standalone manifest, offline write queue with exactly-once replay, web push) and
covers most day-to-day use, but it has a hard ceiling: **a PWA cannot read
HealthKit**, so iOS health data depends on a third-party exporter app (#141),
and there's no biometric app lock, native share-in, or app-store
discoverability.

## Decision (recorded with its rejected alternative)

**Build a thin Capacitor shell around the existing server-rendered web app** —
the Home Assistant / Nextcloud companion model — and **do not build a true
native / React Native client.**

The argument against native is structural: writes are Server Actions and reads
are Server Components, and the only JSON surface is the narrow
[device API](device-api.md) Deck consumes. A native client over every domain
means permanently versioning a REST layer — a second product. The shell renders
the server's own UI instead: no version skew, one maintainer. The PWA remains
fully supported; the shell is additive.

## Goals (v1)

1. **HealthKit exporter** — the headline feature. The shell reads HealthKit and
   POSTs to the Apple Health ingest endpoint (#141), replacing the third-party
   exporter dependency and completing the iOS ingestion story.
2. **Biometric app lock** — Face ID / fingerprint gate in front of the WebView
   (real value: on-device PHI).
3. **Share-in** — receive a PDF/image from the iOS/Android share sheet and hand
   it to the document-import upload flow.
4. **Server-URL onboarding** — first launch asks for the instance URL (standard
   for self-hosted companions), validates via `/api/health`, then loads the
   normal login page.

### Non-goals (v1)

- **No native push.** APNs/FCM need the _publisher's_ keys, which a
  self-hosted server lacks; Telegram + web push already cover reminders.
- **No native UI screens** beyond onboarding/lock, and no offline-first native
  cache beyond the service worker.
- **No Android Health Connect bridge in v1** — the HC push integration already
  works.
- **No tablet/desktop targets.**

## Architecture

```
mobile/                      # Capacitor project, same monorepo
  app/                       # shell source (TS): onboarding, lock, bridges
  ios/  android/             # generated platform projects
```

Monorepo placement keeps the shell versioned next to the ingest contracts it
depends on; it has its own build (Xcode/Gradle via Capacitor CLI) and is
excluded from the web app's `tsc`/vitest/e2e gates. A `mobile/README.md`
documents the build; CI can lint/typecheck `mobile/app` cheaply, but store
builds stay manual (signing).

### Shell behavior

- **Onboarding:** enter/scan server URL → `GET <url>/api/health` to validate
  reachability (the endpoint is public and body-coarse by design) → persist URL
  in native storage → load the site. HTTPS required; plain HTTP allowed only for
  RFC1918/localhost addresses (LAN-only deployments), with a warning.
- **Auth:** the WebView uses the app's normal cookie session (Capacitor WebViews
  persist cookies). No token scheme, no session changes server-side.
  Logout/login are the web flows.
- **Biometric lock:** optional (default on), gates app foregrounding after a
  configurable grace period. Purely local — wraps the WebView, never talks to
  the server. Uses the standard Capacitor biometric plugin.
- **Share-in:** share-sheet registration for PDF/images → the shell opens
  `<server>/data?section=import` and injects the file
  into the existing upload input via the Capacitor share plugin's file handoff.
  No new server endpoint — the existing upload action is the contract.
- **External links** (docs, Strava/SMART OAuth pages) open in the system browser
  / `ASWebAuthenticationSession`, not the WebView — OAuth callbacks then
  deep-link back via a registered URL scheme. **Caveat:** the Strava and SMART
  callbacks are session-gated, so OAuth connect flows stay inside the WebView (a
  real browser context) or are desktop tasks in v1; decide in PR 1 on a device.

### HealthKit exporter bridge

The shell is _an exporter client_ of the #141 ingest endpoint — same contract,
same guards, nothing server-side is shell-specific:

- **Setup:** the profile's ingest token (per-profile issuance UI from #141) is
  entered/scanned once in the shell's settings; stored in the iOS Keychain.
- **Read:** HKObserverQuery + background delivery for the mapped types (weight,
  body fat, steps, HR, sleep, workouts, BP, glucose, SpO2, VO2 max) over a
  rolling 48h window — mirroring the HC exporter's shape so the server-side
  idempotency assumptions (natural-key upserts, rolling-window resends) hold
  unchanged.
- **Push:** POST JSON to `/api/integrations/apple-health/ingest` with the bearer
  token; respect the 2MB cap by chunking days. Failures queue and retry on next
  background wake — the endpoint's idempotency makes duplicate delivery safe
  (#141's design).
- iOS background execution is best-effort; the shell also syncs on every
  foreground. Set expectations in UI copy ("syncs when opened; background sync
  when iOS allows").

**Sequencing:** #141 (the ingest endpoint + parser) lands first.

## Distribution, security, testing

- **iOS:** App Store (self-hosted companions pass review); the privacy policy and
  HealthKit usage strings say data goes only to the user's own server. TestFlight
  for betas. **Android:** Play Store plus the APK on GitHub releases.
- PHI at rest on device is the WebView cache and service-worker storage, as in
  the PWA; biometric lock is the added mitigation. The Keychain ingest token is
  the shell's only credential, revocable server-side. System trust store only: no
  pinning, no insecure-TLS override.
- Tests: no server code changes (#141's tests cover the contract); shell unit
  tests for URL validation and chunking/backoff inside `mobile/`; a manual device
  matrix (iPhone, one Android) for permissions, background delivery, share-in,
  OAuth-in-WebView and re-lock. The web e2e suite is untouched.

## Rollout

1. **PR 1 — walking skeleton:** Capacitor project, onboarding, WebView with
   cookie persistence, biometric lock. Sideloadable build; OAuth-in-WebView
   decision made on-device.
2. **PR 2 — HealthKit exporter bridge** (after #141): read/map/push + settings
   screen + retry queue. TestFlight beta.
3. **PR 3 — share-in + store submission:** share-sheet handoff, store metadata,
   privacy policy, release checklist (incl. Epic-sandbox-style manual gates for
   HealthKit flows).
4. **Later, each its own decision:** Android HC bridge, push relay, home-screen
   widgets, Apple Watch.

Estimated effort: **1.5–2 months** focused, dominated by platform plumbing
(signing, entitlements, background-delivery quirks) rather than app code.

## Open questions

1. **OAuth in WebView vs system browser** (see Shell behavior) — decide in PR 1
   on hardware.
2. **Monorepo CI scope** — proposal: a separate light workflow for `mobile/`, so
   its churn never blocks server CI.
3. **Minimum OS versions** — proposal: iOS 16+, Android 10+.
4. **QR pairing** — a QR (server URL + ingest token) on the integration page;
   PR 2.
