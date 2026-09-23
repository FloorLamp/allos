// DB INTEGRATION TIER — issue #3265, at the SURFACE: Home read the composed one-tap
// against a window it had already left.
//
// The pure pin that held the two windows against each other retired with the placement
// pipeline it measured (#5885), so this is now the whole of #3265's regression cover.
// It asks the only question that binds `app/(app)/page.tsx` itself: at 22:30
// local, does the offer reach the page? It renders the real Home and reads the rows it
// produced, the same way the #3096 census does.
//
// WHAT THE ANSWER LOOKS LIKE CHANGED WITH v3 (#5435 §3.2), and the question did not.
// Home used to place the offer as a candidate of its own, dropped silently when the
// placement pipeline read it as expired; v3 has no placement pipeline and no standalone
// seat for it — the offer IS the seated dose slot's control, "Take all, or the
// usual-routine control when the routine's window is this slot". So the fixture now
// carries an Evening dose so that a slot exists for the control to be, and the
// assertion is that the slot carries the ROUTINE control rather than the plain Take
// all. The revert it still reds on is the same one: read the offer against the meal
// REMINDER windows (`mealTimeWindows`) instead of the food slot's own, and at 22:30
// `getUsualRoutineOffer` is never asked, so the slot falls back to Take all.
//
// The 22:30 pin is the whole fixture: inside a meal window the two windows agree, which
// is why the defect stood. A midday render cannot see it.
//
// The second block pins #6013, the converse seam: past the Morning food window's
// midpoint the clock says Midday, but the seated slot is still Morning, and the offer is
// asked for the seated slot.
//
// Fixtures are synthetic throwaway rows (per-file temp DB via setup.ts). No PHI.

import type { ReactElement } from "react";
import { beforeAll, describe, expect, it, vi, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setProfileSetting, setTimezone } from "@/lib/settings";
import { logUsualRoutineCore } from "@/lib/usual-routine-write";
import { accessibleProfileIdsForLogin, type SessionProfile } from "@/lib/auth";
import { authorizedProfileSubset } from "@/lib/cross-profile";
import UsualRoutineControl from "@/components/dashboard/UsualRoutineControl";
import DoseSlotTakeAll from "@/components/dashboard/DoseSlotTakeAll";
import { resolveAsyncTree } from "@/lib/__db_tests__/dashboard-render-harness";

const session = vi.hoisted(() => ({
  loginId: 0,
  profile: null as SessionProfile | null,
  accessible: [] as SessionProfile[],
}));

vi.mock("@/lib/auth", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireSession: async () => {
      if (!session.profile) throw new Error("dashboard test session not set");
      return {
        login: {
          id: session.loginId,
          username: "routine-window-test",
          role: "admin",
        },
        profile: session.profile,
        access: "write" as const,
        deviceSessionKey: "routine-window-device",
      };
    },
    getAccessibleProfiles: async () => session.accessible,
    ownProfileForLogin: () => session.profile?.id ?? null,
  };
});

vi.mock("@/lib/scope", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/scope")>();
  return {
    ...actual,
    requireScope: async () => {
      if (!session.profile) throw new Error("dashboard test scope not set");
      const ids = authorizedProfileSubset(
        accessibleProfileIdsForLogin(session.loginId),
        session.accessible.map((profile) => profile.id)
      );
      return {
        loginId: session.loginId,
        role: "admin" as const,
        actingProfileId: session.profile.id,
        ownProfileId: session.profile.id,
        profiles: session.accessible,
        ids,
        viewIds: authorizedProfileSubset(ids, [session.profile.id]),
        access: new Map(ids.map((id) => [id, "write" as const])),
      };
    },
  };
});

vi.mock("@/lib/ai-log", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/ai-log")>();
  return { ...actual, withAiLogContext: () => undefined };
});

vi.mock("@/lib/recommendation-engine", async (importActual) => {
  const actual =
    await importActual<typeof import("@/lib/recommendation-engine")>();
  return { ...actual, runRecommendation: () => undefined };
});

// 22:30 local for a UTC profile: past the 21:00 close of the last meal-reminder window,
// with ninety minutes of the Evening FOOD window still to run.
const LATE_EVENING = "2026-08-19T22:30:00.000Z";

// TWO EVENING DOSES, so `attentionEntries` groups the bucket into a SLOT at all: a
// bucket of one due dose stays that dose (#5063), and a lone dose carries no slot
// control for the offer to be. Both are `should`/`daily` and neither is taken today, so
// the slot is due at 22:30 for the same reason the routine still stands.
function seedDose(
  profileId: number,
  name: string,
  timeOfDay: "evening" | "morning" | "midday"
): void {
  const createdAt = `${shiftDateStr(today(profileId), -14)} 00:00:00`;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition, created_at)
         VALUES (?, ?, 'supplement', 1, 'should', 'daily', ?)`
      )
      .run(profileId, name, createdAt).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
     VALUES (?, '1 capsule', ?, 'any', 0, ?)`
  ).run(itemId, timeOfDay, createdAt);
}

function tap(profileId: number, group: string, date: string, hhmmss: string) {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, group, date, `${date}T${hhmmss}Z`);
}

/** Every row the render produced, by the row contract's id (#5435 §5.1). */
let rows = new Map<string, Record<string, unknown>>();

async function renderRows(): Promise<Map<string, Record<string, unknown>>> {
  const { default: Dashboard } = await import("../../app/(app)/page");
  const resolved = await resolveAsyncTree((await Dashboard()) as ReactElement);
  // Keyed on the ROW component's own `id` prop rather than on the `<li>`'s rendered
  // attribute, because the control this file is about is a prop and not markup.
  return new Map(
    resolved.elements
      .filter((props) => typeof props.id === "string" && "control" in props)
      .map((props) => [String(props.id), props])
  );
}

function adminLoginId(): number {
  return (
    db
      .prepare("SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1")
      .get() as { id: number }
  ).id;
}

function actAs(profileId: number): void {
  session.accessible = db
    .prepare(
      `SELECT id, name, photo_path, photo_version FROM profiles WHERE id = ?`
    )
    .all(profileId) as SessionProfile[];
  session.profile = session.accessible[0];
}

describe("the composed one-tap at 22:30 reaches the dashboard (#3265)", () => {
  beforeEach(() => vi.setSystemTime(new Date(LATE_EVENING)));
  beforeAll(async () => {
    vi.setSystemTime(new Date(LATE_EVENING));
    session.loginId = adminLoginId();
    const profileId = Number(
      db
        .prepare("INSERT INTO profiles (name) VALUES (?)")
        .run("routine-late-evening").lastInsertRowid
    );
    setTimezone(profileId, "UTC");
    // Twelve evenings of the same two groups, today deliberately empty, so the offer
    // stands on arrival exactly as the e2e fixture's does.
    const anchor = today(profileId);
    for (let d = 1; d <= 12; d++) {
      const date = shiftDateStr(anchor, -d);
      tap(profileId, "fermented", date, "19:00:00");
      tap(profileId, "berries", date, "19:05:00");
    }
    seedDose(profileId, "Late Magnesium", "evening");
    seedDose(profileId, "Late Glycine", "evening");
    // AND A MORNING SLOT, still owed at 22:30 — the converse below. Two, for the same
    // #5063 reason the Evening pair is two.
    seedDose(profileId, "Late Creatine", "morning");
    seedDose(profileId, "Late Vitamin D", "morning");
    session.accessible = db
      .prepare(
        `SELECT id, name, photo_path, photo_version FROM profiles WHERE id = ?`
      )
      .all(profileId) as SessionProfile[];
    session.profile = session.accessible[0];

    rows = await renderRows();
  }, 120_000);

  it("makes the Evening usual routine the seated slot's control at 22:30", () => {
    const slot = rows.get("attention.fact:dose-slot:Evening");
    // The slot itself is the control: without it there is nothing for the offer to be,
    // and a fixture that stopped producing it would make every assertion below vacuous.
    expect(slot, [...rows.keys()].join(", ")).toBeDefined();
    const control = slot!.control as ReactElement | null;
    expect(control, "the Evening slot carried no control").toBeTruthy();
    // Under the meal-window timing `getUsualRoutineOffer` is never asked at 22:30, so
    // the slot falls back to Take all — which is the revert this file reds on.
    expect(
      control!.type,
      "the Evening slot fell back to Take all, so the routine offer did not reach it"
    ).toBe(UsualRoutineControl);
    expect(control!.type).not.toBe(DoseSlotTakeAll);
    expect((control!.props as { window: string }).window).toBe("Evening");
  });

  // THE CONVERSE, so the assertion above cannot pass by "every slot gets the routine
  // control". The Morning slot is owed at 22:30 too — nothing was taken — and the
  // routine's window is Evening, so Morning carries the plain Take all. Without this,
  // putting the one control on every seated slot would pass unnoticed.
  it("leaves a slot outside the routine's window on plain Take all", () => {
    const slot = rows.get("attention.fact:dose-slot:Morning");
    expect(slot, [...rows.keys()].join(", ")).toBeDefined();
    const control = slot!.control as ReactElement | null;
    expect(control, "the Morning slot carried no control").toBeTruthy();
    expect(control!.type).toBe(DoseSlotTakeAll);
  });
});

// ── #6013: THE SEATED SLOT, NOT THE CLOCK'S FOOD WINDOW ──────────────────────────
//
// Slot hours 07:30 / 12:00 / 18:00 put the Morning/Midday food boundary at 09:45. At
// 10:10 the clock's food window is Midday, but the Midday doses are not due yet, so the
// seated slot is Morning, and the offer must be asked for Morning. At 12:05 Midday is
// due and the latest seated slot takes the control; Morning, still owed, keeps Take all.
const PAST_MIDPOINT = "2026-08-19T10:10:00.000Z";
const MIDDAY_DUE = "2026-08-19T12:05:00.000Z";

// Two profiles, because the 10:10 tap takes the Morning doses the 12:05 case needs owed.
function seedSlotHoursProfile(name: string): number {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  setProfileSetting(profileId, "notify_supp_morning_hour", "07:30");
  setProfileSetting(profileId, "notify_supp_midday_hour", "12:00");
  setProfileSetting(profileId, "notify_supp_evening_hour", "18:00");
  const anchor = today(profileId);
  for (let d = 1; d <= 12; d++) {
    const date = shiftDateStr(anchor, -d);
    tap(profileId, "fermented", date, "08:00:00");
    tap(profileId, "berries", date, "08:05:00");
    tap(profileId, "legumes", date, "12:30:00");
    tap(profileId, "leafy_greens", date, "12:35:00");
  }
  seedDose(profileId, `${name} Creatine`, "morning");
  seedDose(profileId, `${name} Vitamin D`, "morning");
  seedDose(profileId, `${name} Zinc`, "midday");
  seedDose(profileId, `${name} Iron`, "midday");
  return profileId;
}

function slotControl(
  seated: Map<string, Record<string, unknown>>,
  bucket: string
): ReactElement {
  const slot = seated.get(`attention.fact:dose-slot:${bucket}`);
  expect(slot, [...seated.keys()].join(", ")).toBeDefined();
  return slot!.control as ReactElement;
}

describe("the usual routine follows the seated dose slot (#6013)", () => {
  beforeAll(() => {
    session.loginId = adminLoginId();
  });

  it("offers the usual Morning on the Morning row at 10:10, and the tap files Morning", async () => {
    vi.setSystemTime(new Date(PAST_MIDPOINT));
    const profileId = seedSlotHoursProfile("Past midpoint");
    actAs(profileId);
    const seated = await renderRows();
    expect(seated.has("attention.fact:dose-slot:Midday")).toBe(false);
    const control = slotControl(seated, "Morning");
    expect(control.type).toBe(UsualRoutineControl);
    const props = control.props as React.ComponentProps<
      typeof UsualRoutineControl
    >;
    expect(props.window).toBe("Morning");

    const on = today(profileId);
    const outcome = logUsualRoutineCore(
      profileId,
      "Morning",
      on,
      props.food.map((member) => member.slug),
      props.doses.map((dose) => dose.id),
      "dashboard-widget"
    );
    expect(outcome.kind).toBe("logged");
    expect(
      outcome.kind === "logged"
        ? outcome.doses.map((dose) => [dose.name, dose.outcome])
        : []
    ).toEqual([
      ["Past midpoint Creatine", "logged"],
      ["Past midpoint Vitamin D", "logged"],
    ]);
    expect(
      db
        .prepare(
          `SELECT DISTINCT meal_slot FROM food_log_events WHERE profile_id = ? AND date = ?`
        )
        .all(profileId, on)
    ).toEqual([{ meal_slot: "Morning" }]);
  });

  it("moves the control to the Midday row once Midday is due at 12:05", async () => {
    vi.setSystemTime(new Date(MIDDAY_DUE));
    actAs(seedSlotHoursProfile("Midday due"));
    const seated = await renderRows();
    const midday = slotControl(seated, "Midday");
    expect(midday.type).toBe(UsualRoutineControl);
    expect((midday.props as { window: string }).window).toBe("Midday");
    expect(slotControl(seated, "Morning").type).toBe(DoseSlotTakeAll);
  });

  // Once the current slot is logged the control collapses: it does not jump back to the
  // earlier slot still owed (#2458's collapse, e2e/routine-usual.spec.ts).
  it("does not move the control back to Morning once Midday is logged", async () => {
    vi.setSystemTime(new Date(MIDDAY_DUE));
    const profileId = seedSlotHoursProfile("Midday logged");
    actAs(profileId);
    const props = slotControl(await renderRows(), "Midday")
      .props as React.ComponentProps<typeof UsualRoutineControl>;
    expect(
      logUsualRoutineCore(
        profileId,
        "Midday",
        today(profileId),
        props.food.map((member) => member.slug),
        props.doses.map((dose) => dose.id),
        "dashboard-widget"
      ).kind
    ).toBe("logged");
    const seated = await renderRows();
    expect(seated.has("attention.fact:dose-slot:Midday")).toBe(false);
    expect(slotControl(seated, "Morning").type).toBe(DoseSlotTakeAll);
  });
});
