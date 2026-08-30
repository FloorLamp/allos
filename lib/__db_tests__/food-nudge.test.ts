// DB INTEGRATION TIER — the food-log nudge GATHER (issues #682, #1016) over a realistic
// fixture. buildFoodNudge is the gather half (DB reads → the pure renderer): it must lead
// with the profile's most-eaten groups (the SAME recency-decayed ranking the web log bar
// uses — one computation, #591), carry DAY-total button counts (#1016's slot scoping was
// retired with the read-time window derivation it depended on, #2019) beside the "Today:"
// tally, and hide entirely for an infant profile (the life-stage gate). The
// pure render/token half is covered in lib/__tests__/food-nudge.test.ts.

import { plainBody } from "@/lib/notifications/rich-text";
import { describe, it, expect, beforeAll } from "vitest";
import { today } from "@/lib/db";
import { setProfileSetting, setProfileBirthdate } from "@/lib/settings";
import { setProfileSubstanceTelegram } from "@/lib/settings/notifications";
import { logFoodServingCore } from "@/lib/food-log-write";
import { addProteinGramsCore } from "@/lib/protein-daily-totals-write";
import { shiftDateStr } from "@/lib/date";
import { db } from "@/lib/db";
import { buildFoodNudge } from "@/lib/notifications/food";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;
let t: string;

beforeAll(() => {
  p = seedProfile("food-nudge");
  t = today(p.profileId);
  // Heavy recent leafy-greens habit at MORNING → it leads the buttons and shows a slot
  // count on the morning nudge; one morning fatty-fish log too. Default UTC tz + 11:00/15:00
  // boundaries → an 08:00Z tap is Morning. logFoodServingCore writes BOTH the food_daily_totals day
  // counter and the food_log_events ledger the slot count reads.
  for (let i = 0; i < 4; i++)
    logFoodServingCore(
      p.profileId,
      "leafy_greens",
      t,
      "page",
      `${t}T08:0${i}:00Z`
    );
  logFoodServingCore(p.profileId, "fatty_fish", t, "page", `${t}T08:30:00Z`);
});

describe("buildFoodNudge", () => {
  it("leads with the most-eaten group and carries DAY counts + the DAY tally", () => {
    const msg = buildFoodNudge(p.profileId, "Morning", t);
    expect(msg).not.toBeNull();
    const logButtons = (msg!.actions ?? []).filter((a) =>
      a.data?.startsWith("food:")
    );
    // First button is the heavily-logged group, carrying its day count (4).
    expect(logButtons[0].label).toBe("🥬 Greens (4)");
    expect(logButtons[0].data).toBe(
      `food:${p.profileId}:Morning:${t}:leafy_greens`
    );
    // The tally line is the DAY total, labeled.
    expect(plainBody(msg!.body)).toContain("✅ Today: 🥬 Greens ×4");
    expect(plainBody(msg!.body)).toContain("Fatty fish ×1");
    expect(msg!.kind).toBe("food");
  });

  it("carries the SAME count on every window's nudge — the count is the day (#2019)", () => {
    // The suffix no longer means "in this window", so a morning habit reads 4 on the
    // midday nudge too. That is the point: the count agrees with the tally beside it and
    // never depends on re-deriving which meal a serving belonged to.
    const msg = buildFoodNudge(p.profileId, "Midday", t);
    const leafy = (msg!.actions ?? []).find((a) =>
      a.data?.endsWith(":leafy_greens")
    );
    // Labels lead with the catalog glyph (#1710) and the SHORT catalog name.
    expect(leafy?.label).toBe("🥬 Greens (4)");
    expect(plainBody(msg!.body)).toContain("✅ Today: 🥬 Greens ×4");
  });

  it("still leads with the group eaten NEAR this window (#2019 proximity ranking)", () => {
    // The ORDER is what stayed slot-aware, and it did so without a bucket: the morning
    // habit leads the morning nudge because 08:00 sits on that window's anchor.
    const morning = (buildFoodNudge(p.profileId, "Morning", t)!.actions ?? [])
      .filter((a) => a.data?.startsWith("food:"))
      .map((a) => a.data!.split(":").at(-1));
    expect(morning[0]).toBe("leafy_greens");
  });

  it("hides for an infant profile (life-stage gate)", () => {
    const infant = seedProfile("food-nudge-infant");
    // < 1 y old → food-group logging is hidden everywhere, nudge included.
    const bd = new Date(t);
    setProfileBirthdate(
      infant.profileId,
      `${bd.getUTCFullYear()}-${String(bd.getUTCMonth() + 1).padStart(2, "0")}-01`
    );
    expect(buildFoodNudge(infant.profileId, "Morning", t)).toBeNull();
  });
});

// ---- Ranking does not editorialize (#1980, reversing #1822 item 5) ----
//
// #1822 item 5 pushed CAPPED groups below every floor group on this keyboard, so a
// heavily-logged "🍷 Alcohol" could not take an above-the-fold button. #1980 reversed it
// by owner ruling: a group you log often is a group you need to log FAST, and demoting it
// made the app slower at capturing exactly the intake a cap exists to measure. Driven
// through the REAL gather, so the order is proved where the buttons are actually built.
describe("capped groups rank on frecency alone (#1980 reversal pin)", () => {
  let c: SeededProfile;
  let ct: string;

  beforeAll(() => {
    c = seedProfile("food-nudge-capped");
    ct = today(c.profileId);
    // #3330 PUT THIS FIXTURE ON THE WRONG SIDE OF A NEW BOUNDARY, so it declares its side
    // explicitly. Alcohol's counter is the substance ledger, and substance content now
    // reaches a chat only for a profile that opted in — without this line the exemplar is
    // simply absent from every keyboard below and the #1980 ranking pin asserts nothing.
    // The two rules are orthogonal: the opt-in decides whether the row may be SENT, this
    // block decides where it RANKS once it may be.
    setProfileSubstanceTelegram(c.profileId, true);
    // Alcohol is the profile's single heaviest morning habit — it wins the frecency blend
    // outright, and nothing may take that away from it.
    for (let i = 0; i < 6; i++)
      logFoodServingCore(
        c.profileId,
        "alcohol",
        ct,
        "page",
        `${ct}T08:0${i}:00Z`
      );
    logFoodServingCore(c.profileId, "berries", ct, "page", `${ct}T08:30:00Z`);
  });

  it("the top-usage capped group LEADS the visible keyboard, count intact", () => {
    const msg = buildFoodNudge(c.profileId, "Morning", ct)!;
    const labels = (msg.actions ?? [])
      .filter((a) => a.data?.startsWith("food:"))
      .map((a) => a.label);
    expect(labels[0]).toBe("🍷 Alcohol (6)");
    expect(labels[1]).toBe("🫐 Berries (1)");
  });

  it("ranks the same way in EVERY slot — the tier is never consulted", () => {
    for (const window of ["Morning", "Midday", "Evening"] as const) {
      const msg = buildFoodNudge(c.profileId, window, ct)!;
      const labels = (msg.actions ?? [])
        .filter((a) => a.data?.startsWith("food:"))
        .map((a) => a.label);
      // The morning taps carry no slot count outside Morning, but the overall frecency
      // that put alcohol first is window-independent.
      expect(labels.some((l) => l.includes("Alcohol"))).toBe(true);
    }
  });

  it("the user's own exclusion still demotes it — the ONE thing that reorders", () => {
    // #975 is a choice the user made, not a verdict the app formed.
    setProfileSetting(
      c.profileId,
      "dietary_excluded_groups",
      JSON.stringify(["alcohol"])
    );
    try {
      const msg = buildFoodNudge(c.profileId, "Morning", ct)!;
      const labels = (msg.actions ?? [])
        .filter((a) => a.data?.startsWith("food:"))
        .map((a) => a.label);
      expect(labels.some((l) => l.includes("Alcohol"))).toBe(false);
      // Demoted, never filtered (#559): a wide-enough keyboard still reaches it.
      const wide = buildFoodNudge(c.profileId, "Morning", ct, 30)!;
      const alcohol = (wide.actions ?? []).find((a) =>
        a.data?.endsWith(":alcohol")
      );
      expect(alcohol?.label).toBe("🍷 Alcohol (6)");
    } finally {
      setProfileSetting(c.profileId, "dietary_excluded_groups", "[]");
    }
  });
});

// ── A REBUILT NUDGE IS ABOUT ITS OWN DAY, INCLUDING ITS PROTEIN LINE (#4118) ──
//
// Once the sweep began honouring a food keyboard for two days after its message, the
// hourly tick started REBUILDING past-day nudges — and every figure on that render was
// read for the message's day except one. `getProteinToday` resolved `today()` inside
// itself, so a D−1 message was repainted with the CURRENT day's grams and the CURRENT
// day's "goal reached" verdict, beside a tally and button counts that were correct.
//
// That is a false health claim in the notification tier, it persists (`food` is
// `reissuable: false`, so the message stays live until the next food nudge — for ever if
// they stop), and it is repainted every tick. The fix is the DATE, not the guard.
describe("a past-day rebuild states that day's protein, and says whose day it is", () => {
  it("does not paint today's grams — or its verdict, or the word Today — onto yesterday", () => {
    const sp = seedProfile("nudge-past-protein");
    const anchor = today(sp.profileId);
    const y = shiftDateStr(anchor, -1);
    // A big day today, a small one yesterday, chosen so the two are far apart and one
    // clears its goal band while the other does not — the defect showed today's figure
    // AND today's verdict on yesterday's message.
    expect(
      addProteinGramsCore(sp.profileId, y, 11, "page", `${y}T08:00:00Z`).kind
    ).toBe("logged");
    expect(
      addProteinGramsCore(
        sp.profileId,
        anchor,
        137,
        "page",
        `${anchor}T08:00:00Z`
      ).kind
    ).toBe("logged");
    // A serving on EACH day, so both messages carry a tally line — the "Today:" label
    // is only rendered when there is something to tally, and a converse asserted on a
    // message that has no tally at all asserts nothing.
    logFoodServingCore(
      sp.profileId,
      "leafy_greens",
      y,
      "page",
      `${y}T08:10:00Z`
    );
    logFoodServingCore(
      sp.profileId,
      "leafy_greens",
      anchor,
      "page",
      `${anchor}T08:10:00Z`
    );

    // The figure each message states, read out of the rendered line rather than pinned
    // as a literal: the day's total is the quick-add PLUS that day's estimated
    // contribution from the servings, so a hardcoded number would be asserting the
    // estimator's arithmetic instead of the day the line is about.
    const grams = (body: string) => Number(/Protein: (\d+) g/.exec(body)?.[1]);

    const past = plainBody(buildFoodNudge(sp.profileId, "Morning", y)!.body);
    const live = plainBody(
      buildFoodNudge(sp.profileId, "Morning", anchor)!.body
    );

    // TWO DAYS, TWO FIGURES. The defect made them the same number; this is the shortest
    // statement of that being over.
    expect(grams(past)).toBeLessThan(grams(live));
    expect(grams(past)).toBeLessThan(50);
    expect(grams(live)).toBeGreaterThan(130);
    // And above all the VERDICT does not travel: "goal reached" on a day the person was
    // nowhere near their band is the false health claim this pins.
    expect(past).not.toContain("goal reached");
    // …nor may any line on a past-day message call that day "Today".
    expect(past).not.toContain("Today:");
    expect(past).toContain(y);

    // THE CONVERSE, same profile, same builder: today's message still says Today and
    // still reaches its goal. Without it, "never says goal reached" and "never says
    // Today:" would both pass on a build that had lost the lines altogether.
    expect(live).toContain("Today:");
    expect(live).toContain("goal reached");
  });

  it("the no-target day-grams line names the day too", () => {
    // The OTHER protein line (#1073): a protein tracker with no bodyweight gets a bare
    // grams sentence with no band, and it hardcoded the word "today" the same way. A
    // bare profile row, because `seedProfile` seeds a weight and would take the branch
    // above instead — a fixture that never reaches the line it is about asserts nothing.
    const profileId = Number(
      db
        .prepare(
          "INSERT INTO profiles (name) VALUES ('nudge-past-protein-notarget')"
        )
        .run().lastInsertRowid
    );
    const anchor = today(profileId);
    const y = shiftDateStr(anchor, -1);
    expect(
      addProteinGramsCore(profileId, y, 22, "page", `${y}T08:00:00Z`).kind
    ).toBe("logged");

    const past = plainBody(buildFoodNudge(profileId, "Morning", y)!.body);
    expect(past).toContain(`22 g on ${y}`);
    expect(past).not.toContain("22 g today");
    // The converse: the same line on the live message still reads "today".
    expect(
      addProteinGramsCore(profileId, anchor, 40, "page", `${anchor}T08:00:00Z`)
        .kind
    ).toBe("logged");
    expect(
      plainBody(buildFoodNudge(profileId, "Morning", anchor)!.body)
    ).toContain("40 g today");
  });
});
