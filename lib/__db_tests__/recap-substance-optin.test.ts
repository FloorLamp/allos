// DB INTEGRATION TIER — the per-profile SUBSTANCE-content consent on the periodic
// RECAP (#3900), asserted on the rendered message string.
//
// THE DEFECT. `cadenceScopeNoun` names a substance cap by its own noun — the curated
// label for a curated key, the profile's OWN free-text name for a custom one — and both
// cadence cap readers hand that to the recap: the week-scale verdict line ("over the
// Nicotine cap") and the month-scale cap-weeks line ("over the … cap in 2 of 4 weeks").
// `runRecap` sends that over Telegram, Web Push and Email with
// `substance_telegram_enabled` never set. Ported to origin/main, every opted-out row
// below fails.
//
// WHY THIS TIER AND WHY THE MESSAGE STRING. The gate is a gather, so a pure test over a
// hand-built verdict array cannot fail for a recap that asks the ledger anyway; and the
// two lines are assembled by different builders, so asserting on the rendered body is
// the only check that covers both the way a reader meets them.
//
// AND THE IN-APP SURFACES MUST NOT MOVE. The same gather feeds the dashboard recap card
// and the AI narrative's facts — surfaces the profile is standing on, where the consent
// says nothing. Those rows are the ones that stop this fix becoming a regression.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setWeekMode } from "@/lib/settings";
import {
  setProfileSubstanceTelegram,
  setRecapScale,
} from "@/lib/settings/notifications";
import {
  gatherRecapInput,
  getRecapCard,
  getScaleRecap,
} from "@/lib/notifications/recap-data";
import { buildRecap, renderRecapMessage } from "@/lib/recap";
import { plainBody } from "@/lib/notifications/rich-text";

const NOW = new Date("2026-06-17T12:00:00Z");

// Rolling week mode throughout, so a weekly window is exactly the trailing seven days.
function newProfile(name: string): number {
  const pid = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setWeekMode(pid, "rolling");
  return pid;
}

const dayBack = (pid: number, back: number) => shiftDateStr(today(pid), -back);

// `created_at` is explicit for the same reason as every other cadence fixture: the
// column defaults to SQLite's `datetime('now')`, which the fake clock does not move, so
// a defaulted target looks younger than the window and trips the cold-start guard.
function capTarget(pid: number, value: string): void {
  db.prepare(
    `INSERT INTO frequency_targets
       (profile_id, scope_kind, scope_value, per_week, per_week_max, created_at)
     VALUES (?, 'substance', ?, 1, NULL, ?)`
  ).run(pid, value, `${dayBack(pid, 300)} 08:00:00`);
}

// Alcohol's ledger IS the `alcohol` food group (#860/#944); every other substance,
// curated or custom, counts in `substance_daily_totals`.
function logUse(pid: number, date: string, scope: string): void {
  if (scope === "alcohol") {
    db.prepare(
      `INSERT INTO food_daily_totals (profile_id, date, group_key, servings)
       VALUES (?, ?, 'alcohol', 4)`
    ).run(pid, date);
    return;
  }
  db.prepare(
    `INSERT INTO substance_daily_totals (profile_id, date, substance, units)
     VALUES (?, ?, ?, 4)`
  ).run(pid, date, scope);
}

function logWeight(pid: number, date: string): void {
  db.prepare(
    "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, 70.2)"
  ).run(pid, date);
}

// One capped substance, used every day of the last ten weeks so the cap is over in every
// window either scale can ask about, plus ordinary body-weight rows so the recap has
// non-substance content and is never `isEmpty`.
function cappedProfile(name: string, scope: string): number {
  const pid = newProfile(name);
  capTarget(pid, scope);
  for (let back = 0; back <= 70; back++) {
    logUse(pid, dayBack(pid, back), scope);
    logWeight(pid, dayBack(pid, back));
  }
  return pid;
}

const sendBody = (pid: number, scale: "week" | "month"): string => {
  const msg = renderRecapMessage(
    buildRecap(
      gatherRecapInput(pid, "kg", scale, true, today(pid), true)
    ),
    "Robin",
    null,
    "https://example.test"
  );
  return msg ? plainBody(msg.body) : "";
};

// The two rendered sentences, per scale: the week's verdict line and the month's
// cap-weeks line. The month's week count comes from the period, so it is matched
// loosely on its "N of M weeks" tail.
const capSentence = (label: string, scale: "week" | "month"): RegExp =>
  scale === "week"
    ? new RegExp(`over the ${label} cap(?! in)`)
    : new RegExp(`over the ${label} cap in \\d+ of \\d+ weeks`);

// Curated counter-ledger, a name the profile typed itself, and alcohol — #3846's own
// subject, still named by a send it did not gate.
const SUBSTANCES = [
  { scope: "nicotine", label: "Nicotine" },
  { scope: "Evening tincture", label: "Evening tincture" },
  { scope: "alcohol", label: "Alcohol" },
] as const;

const SCALES = ["week", "month"] as const;

const CASES = SUBSTANCES.flatMap((s) =>
  SCALES.map((scale) => ({ ...s, scale }))
);

describe("the outbound recap asks the substance consent (#3900)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(CASES)(
    "$scale scale: never names $label with the consent unset",
    ({ scope, label, scale }) => {
      const pid = cappedProfile(`recap-optout-${scope}-${scale}`, scope);
      const body = sendBody(pid, scale);
      expect(body).not.toContain(label);
      expect(body).not.toMatch(capSentence(label, scale));
      // Removed, not suppressed: the rest of the recap still goes out.
      expect(body).toContain("kg");
    }
  );

  it.each(CASES)(
    "$scale scale: names $label exactly as before once consented",
    ({ scope, label, scale }) => {
      const pid = cappedProfile(`recap-optin-${scope}-${scale}`, scope);
      setProfileSubstanceTelegram(pid, true);
      expect(sendBody(pid, scale)).toMatch(capSentence(label, scale));
    }
  );

  it.each(SUBSTANCES)(
    "leaves $label on the in-app card and the AI narrative's facts with the consent unset",
    ({ scope, label }) => {
      const pid = cappedProfile(`recap-inapp-${scope}`, scope);
      // The cap line speaks at month scale, and the card shows the profile's chosen
      // scale IN PROGRESS — so this is the card a month-scale profile is looking at.
      setRecapScale(pid, "month");
      const card = getRecapCard(pid).lines.find((l) => l.key === "caps");
      const narrated = getScaleRecap(pid, "month").lines.find(
        (l) => l.key === "caps"
      );
      for (const line of [card, narrated])
        expect(line?.value).toMatch(capSentence(label, "month"));
    }
  );

  it("cannot manufacture a new empty recap — a cap-only period was already silent", () => {
    // Target verdicts and caps are deliberately not `isEmpty` evidence (lib/recap.ts),
    // so a period whose only content is a substance cap renders nothing either way and
    // dropping the cap changes no verdict. Nicotine, not alcohol: an alcohol row is a
    // food row, and food coverage IS evidence.
    const pid = newProfile("recap-optout-empty");
    capTarget(pid, "nicotine");
    for (let back = 0; back <= 70; back++)
      logUse(pid, dayBack(pid, back), "nicotine");
    expect(sendBody(pid, "week")).toBe("");
    setProfileSubstanceTelegram(pid, true);
    expect(sendBody(pid, "week")).toBe("");
  });
});
