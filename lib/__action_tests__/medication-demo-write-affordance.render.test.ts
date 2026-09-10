// SERVER-COMPONENT RENDER TIER — the medication detail page's write affordances in
// demo mode (#4844 item 2).
//
// WHAT THIS PINS, AND WHY AT THIS ALTITUDE. Both affordance facts on that page used to
// be computed from the #33 grant alone and never consulted demo posture, while every
// write gate behind them refuses a demo-restricted login outright — so a write-granted
// non-admin under ALLOS_DEMO_MODE was shown a live-looking "Log past dose" (and "Add
// side effect", and the whole ⋯ menu) that redirected to `/` on tap. The failure is a
// control that LOOKS live, so an assertion that a derivation returned false does not
// see it: it would pass with the control still rendered and still bouncing. This file
// therefore renders the page for real and asserts over the HTML a browser would get.
//
// The page is an async server component, so it is awaited directly; the client subtree
// below it is then rendered with react-dom/server inside the same providers the app
// layout supplies, which is what makes "Log past dose" a string in the output rather
// than a prop on an element nobody executed.
//
// THE PERMITTING CASES ARE LOAD-BEARING. A derivation that refuses everybody — an
// inverted consult, a helper that always returns false — passes any suite made only of
// refusals. So the same seeded page is asserted to render the LIVE control with the
// flag off (both arms), and for the demo instance's ADMIN with the flag on, which is
// the operator posture lib/demo keeps functional.
//
// WHY A WRITE-GRANTED MEMBER IS THE REALISTIC SUBJECT. scripts/seed.ts gives the seeded
// "demo" login READ grants, so on that instance both facts already answered false. The
// reachable case is the flag on an instance whose members hold ordinary write grants,
// or a grant misconfigured to 'write' on a demo one — the same belt-and-braces case
// lib/auth's assertNotDemoRestricted exists for.

import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "@/lib/db";
import { createLogin, createProfile, actAs, type TestProfile } from "./harness";

// The card mounts client controls that read the router; SSR never navigates, so the
// stand-in only has to exist. `notFound`/`redirect` keep their real implementations —
// this page 404s on an unreachable id and a test must not silently lose that.
vi.mock("next/navigation", async () => {
  const actual =
    await vi.importActual<typeof import("next/navigation")>("next/navigation");
  return {
    ...actual,
    useRouter: () => ({
      push: () => {},
      replace: () => {},
      refresh: () => {},
      back: () => {},
      prefetch: () => {},
    }),
    usePathname: () => "/medications",
    useSearchParams: () => new URLSearchParams(),
  };
});

import MedicationDetailPage from "@/app/(app)/medications/[id]/page";
import { ToastProvider } from "@/components/Toast";
import { ConfirmProvider } from "@/components/ConfirmDialog";
import { TimezoneProvider } from "@/components/TimezoneProvider";
import { WeekStartProvider } from "@/components/WeekStartProvider";
import { FormatPrefsProvider } from "@/components/FormatPrefsProvider";
import { ActiveProfileProvider } from "@/components/ActiveProfileProvider";
import DirtyFormProvider from "@/components/DirtyFormRegistry";
import OfflineQueueProvider from "@/components/OfflineQueueProvider";

// The layout providers the medication card's controls require, innermost last. Only
// the ones a mount actually reads — this is the app's own stack, not a fake.
function withLayoutProviders(activeProfileId: number, page: ReactNode) {
  const layers: [unknown, Record<string, unknown>][] = [
    [ToastProvider, {}],
    [TimezoneProvider, { tz: "UTC" }],
    [WeekStartProvider, { weekStart: "monday" }],
    [FormatPrefsProvider, { prefs: { timeFormat: "24h", dateFormat: "iso" } }],
    [ConfirmProvider, {}],
    [ActiveProfileProvider, { profileId: activeProfileId }],
    [DirtyFormProvider, {}],
    [
      OfflineQueueProvider,
      { activeProfileId, deviceSessionKey: "render-test" },
    ],
  ];
  return layers.reduceRight<ReactNode>(
    (acc, [Comp, props]) => createElement(Comp as never, props as never, acc),
    page
  );
}

// A scheduled medication with one dose and one open course — enough that the dose
// history's backfill door is genuinely offerable, so its absence in demo mode is the
// affordance being withheld rather than the medication having nothing to log.
function seedMedication(profileId: number, name: string): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, source)
         VALUES (?, ?, 1, 'medication', 'daily', 'must', 'manual')`
      )
      .run(profileId, name).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '400 mg', 'morning', 'any', 0)`
  ).run(itemId);
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, created_at)
     VALUES (?, '2026-01-01', '2026-01-01T00:00:00Z')`
  ).run(itemId);
  return itemId;
}

async function renderPage(
  actingProfile: TestProfile,
  medicationId: number
): Promise<string> {
  const tree = await MedicationDetailPage({
    params: Promise.resolve({ id: String(medicationId) }),
    searchParams: Promise.resolve({}),
  });
  return renderToStaticMarkup(
    withLayoutProviders(actingProfile.id, tree as ReactNode) as never
  );
}

// One caregiver login holding ordinary WRITE grants on two profiles: their own, and a
// household member's. The same seed serves both arms — the acting-profile affordance
// and the cross-profile subject one.
function seedCaregiver(label: string, role: "member" | "admin" = "member") {
  const login = createLogin({ role });
  const own = createProfile(`${label} self`, login.id);
  const other = createProfile(`${label} ward`, login.id);
  actAs(login, own, "write");
  return {
    login,
    own,
    other,
    ownMed: seedMedication(own.id, `${label} ibuprofen`),
    otherMed: seedMedication(other.id, `${label} amoxicillin`),
  };
}

// Narrow one of the seeded grants to view-only (#33). `createProfile` grants with a
// NULL access, which reads back as 'write'.
function makeReadOnly(login: { id: number }, profile: TestProfile): void {
  db.prepare(
    "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
  ).run(login.id, profile.id);
}

afterEach(() => {
  // process.env is shared across the worker — always clear, or a later file silently
  // runs in demo mode.
  delete process.env.ALLOS_DEMO_MODE;
});

describe("the medication page's write affordances in demo mode", () => {
  // PERMITTING, acting profile. Without this a derivation that refuses everyone would
  // satisfy every refusal below.
  it("offers the live controls to a write-granted member with the flag off", async () => {
    const c = seedCaregiver("flagoff-own");
    const html = await renderPage(c.own, c.ownMed);

    expect(html).toContain("Log past dose");
    expect(html).toContain("Add side effect");
  });

  // The blind spot on the login's OWN profile — the `canWrite` half, which the issue
  // did not name. Nothing cross-profile is involved here.
  it("withholds them from the same member on their own profile in demo mode", async () => {
    process.env.ALLOS_DEMO_MODE = "1";
    const c = seedCaregiver("demo-own");
    const html = await renderPage(c.own, c.ownMed);

    // The page still rendered — so the absences below mean "withheld", not "blank".
    expect(html).toContain("demo-own ibuprofen");
    expect(html).not.toContain("Log past dose");
    expect(html).not.toContain("Add side effect");
  });

  // PERMITTING, cross-profile subject: the day affordances follow the surface, and the
  // note says so. This is the arm the issue named.
  it("offers the subject's day affordances cross-profile with the flag off", async () => {
    const c = seedCaregiver("flagoff-cross");
    const html = await renderPage(c.own, c.otherMed);

    expect(html).toContain("Log past dose");
    expect(html).toContain("Doses you log here are");
  });

  it("withholds them cross-profile in demo mode, and says read-only instead", async () => {
    process.env.ALLOS_DEMO_MODE = "1";
    const c = seedCaregiver("demo-cross");
    const html = await renderPage(c.own, c.otherMed);

    expect(html).toContain("demo-cross amoxicillin");
    expect(html).not.toContain("Log past dose");
    expect(html).not.toContain("Doses you log here are");
    // The read-only rendering the page already had for an ungranted subject.
    expect(html).toContain("to make changes");
  });

  // THE OTHER HALF OF THE SAME DERIVATION. It answers on the grant AND the demo
  // posture, so a fold that quietly stopped reading the grant would offer a view-only
  // caregiver every control — and the demo cases above, which all seed write grants,
  // would not notice. One case per arm.
  it("withholds them from a view-only member on their own profile", async () => {
    const c = seedCaregiver("readonly-own");
    makeReadOnly(c.login, c.own);
    const html = await renderPage(c.own, c.ownMed);

    expect(html).toContain("readonly-own ibuprofen");
    expect(html).not.toContain("Log past dose");
    expect(html).not.toContain("Add side effect");
  });

  it("withholds them for a view-only grant on the cross-profile subject", async () => {
    const c = seedCaregiver("readonly-cross");
    makeReadOnly(c.login, c.other);
    const html = await renderPage(c.own, c.otherMed);

    expect(html).toContain("readonly-cross amoxicillin");
    expect(html).not.toContain("Log past dose");
    expect(html).not.toContain("Doses you log here are");
    expect(html).toContain("to make changes");
  });

  // PERMITTING, and role-sensitive: demo mode restricts NON-ADMINS. An admin keeps the
  // live controls, so a fold that consulted the flag alone — or refused unconditionally
  // — is not enough to pass this file.
  it("leaves the demo instance's admin fully functional", async () => {
    process.env.ALLOS_DEMO_MODE = "1";
    const c = seedCaregiver("demo-admin", "admin");
    const html = await renderPage(c.own, c.ownMed);

    expect(html).toContain("Log past dose");
    expect(html).toContain("Add side effect");
  });
});
