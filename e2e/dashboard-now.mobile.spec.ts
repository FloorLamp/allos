import { test, expect } from "./fixtures";
import { type Browser, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  expectNoClippedContent,
  expectPhoneTapTargets,
  openDashboardAll,
  settledBoxes,
} from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_DAILY,
  E2E_LOGIN_SICK_SELF,
  E2E_LOGIN_NOWSTRIP,
  E2E_LOGIN_NOWSAFETY,
  E2E_LOGIN_NOWQUIET,
  E2E_LOGIN_PACEBEHIND,
  E2E_LOGIN_WHATSNEW,
  NOW_QUIET_TARGETS,
  PACE_BEHIND_TARGETS,
} from "./fixture-logins";

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };
const DESKTOP = { viewport: { width: 1280, height: 900 }, hasTouch: false };

async function openDashboard(
  browser: Browser,
  creds: { username: string },
  contextOptions: Record<string, unknown> = PHONE
): Promise<Page> {
  const page = await loginAs(
    browser,
    { username: creds.username, password: E2E_MEMBER_PASSWORD },
    contextOptions
  );
  await page.goto("/");
  return page;
}

function insertRecentlyEndedNap(username: string): () => void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare(
        `SELECT lp.profile_id
           FROM logins l JOIN login_profiles lp ON lp.login_id = l.id
          WHERE l.username = ?
          ORDER BY lp.profile_id
          LIMIT 1`
      )
      .get(username) as { profile_id: number };
    const end = new Date(frozenNow().getTime() - 30 * 60_000);
    const start = new Date(end.getTime() - 30 * 60_000);
    const wakeDay = frozenNow().toISOString().slice(0, 10);
    const insert = db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, started_at, ended_at, value)
       VALUES (?, 'manual', 'sleep_min', ?, ?, ?, ?)`
    );
    const mainEnd = new Date(frozenNow().getTime() - 6 * 60 * 60_000);
    const mainStart = new Date(mainEnd.getTime() - 8 * 60 * 60_000);
    const ids = [
      Number(
        insert.run(
          profile.profile_id,
          wakeDay,
          mainStart.toISOString(),
          mainEnd.toISOString(),
          480
        ).lastInsertRowid
      ),
      Number(
        insert.run(
          profile.profile_id,
          wakeDay,
          start.toISOString(),
          end.toISOString(),
          30
        ).lastInsertRowid
      ),
    ];
    return () => {
      const cleanupDb = new Database(workerDbPath());
      try {
        cleanupDb.pragma("busy_timeout = 5000");
        cleanupDb
          .prepare("DELETE FROM metric_samples WHERE id IN (?, ?)")
          .run(...ids);
      } finally {
        cleanupDb.close();
      }
    };
  } finally {
    db.close();
  }
}

// #3548 cold start: the first record a profile makes. Direct-DB, spec-owned and
// cleaned up, in the `insertRecentlyEndedNap` idiom above — the claim under test is
// what the NEXT render does, so driving a real log form would only add ways for the
// fixture to fail for reasons that are not the ruling.
function insertFirstWeighIn(username: string): () => void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare(
        `SELECT lp.profile_id
           FROM logins l JOIN login_profiles lp ON lp.login_id = l.id
          WHERE l.username = ?
          ORDER BY lp.profile_id
          LIMIT 1`
      )
      .get(username) as { profile_id: number };
    const day = frozenNow().toISOString().slice(0, 10);
    const id = Number(
      db
        .prepare(
          `INSERT INTO body_metrics (profile_id, date, weight_kg, source)
           VALUES (?, ?, 71.5, NULL)`
        )
        .run(profile.profile_id, day).lastInsertRowid
    );
    return () => {
      const cleanupDb = new Database(workerDbPath());
      try {
        cleanupDb.pragma("busy_timeout = 5000");
        cleanupDb.prepare("DELETE FROM body_metrics WHERE id = ?").run(id);
      } finally {
        cleanupDb.close();
      }
    };
  } finally {
    db.close();
  }
}

test("phone leads with the bounded Now lane", async ({ browser }) => {
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_NOWSTRIP,
  });
  try {
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true })
    ).toHaveCount(0);
    const strip = page.getByTestId("now-strip");
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute("data-count", "2");
    await expect(strip.getByTestId("now-strip-date")).toBeVisible();
    await expectNoClippedContent(page);
  } finally {
    await page.context().close();
  }
});

test("Now stays one column at every viewport", async ({ browser }) => {
  for (const options of [PHONE, DESKTOP]) {
    const page = await openDashboard(
      browser,
      { username: E2E_LOGIN_NOWSTRIP },
      options
    );
    try {
      const strip = page.getByTestId("now-strip");
      const cards = strip.locator(
        '[data-testid="dashboard-candidate"][data-lane="now"]'
      );
      await expect(cards).toHaveCount(2);
      const [top, bottom] = await settledBoxes([cards.nth(0), cards.nth(1)]);
      expect(bottom.y).toBeGreaterThan(top.y + top.height / 2);
      expect(Math.abs(bottom.x - top.x)).toBeLessThan(2);
      expect(Math.abs(bottom.width - top.width)).toBeLessThan(2);
    } finally {
      await page.context().close();
    }
  }
});

test("desktop keeps the page header", async ({ browser }) => {
  const page = await openDashboard(
    browser,
    { username: E2E_LOGIN_NOWSTRIP },
    DESKTOP
  );
  try {
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true })
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("an empty Now keeps its quiet state and mobile date", async ({
  browser,
}) => {
  // NOW_QUIET, not WHATS_NEW: since #3548 a profile that has recorded NOTHING is a
  // cold start, and its tier is a getting-started list that the settled sentence may
  // not sit over. This fixture's day is genuinely handled, which is the state the
  // sentence is for.
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_NOWQUIET,
  });
  try {
    const strip = page.getByTestId("now-strip");
    await expect(strip).toHaveAttribute("data-count", "0");
    await expect(strip.getByTestId("now-strip-empty")).toHaveText(
      "Nothing needs you."
    );
    await expect(strip.getByTestId("now-strip-date")).toBeVisible();
    await expect(
      strip.locator('[data-testid="dashboard-candidate"][data-lane="now"]')
    ).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test("an ended nap moves into an otherwise-empty Now exactly once", async ({
  browser,
}) => {
  const cleanup = insertRecentlyEndedNap(E2E_LOGIN_WHATSNEW);
  try {
    const page = await openDashboard(browser, {
      username: E2E_LOGIN_WHATSNEW,
    });
    try {
      const naps = page.locator(
        '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap:"]'
      );
      await expect(naps).toHaveCount(1);
      await expect(naps).toHaveAttribute("data-lane", "now");
      await expect(page.getByTestId("now-strip-empty")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  } finally {
    cleanup();
  }
});

test("read-only safety facts remain uncapped and actionable", async ({
  browser,
}) => {
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_NOWSAFETY,
  });
  try {
    await expect(page.getByTestId("now-strip-empty")).toHaveCount(0);
    const fact = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="attention.fact:mental-health:crisis"]'
    );
    await expect(fact).toHaveCount(1);
    await expect(fact).toBeVisible();
    await expect(fact).toHaveAttribute("data-kind", "statement");
    await expect(fact).toHaveAttribute("data-lane", "now");
    const links = fact.getByRole("link");
    await expect(links).toHaveCount(1);
    await expect(links).toBeVisible();
    await expect(fact.getByRole("button")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

// #3224 — the goal state on a real week. A handled day whose only outstanding facts
// are unmet weekly targets must read "Nothing needs you.", not two log offers: an
// unmet target is a seven-day span, and a span is not a window.
test("unmet weekly targets leave a handled day's Now empty", async ({
  browser,
}) => {
  const page = await openDashboard(browser, { username: E2E_LOGIN_NOWQUIET });
  try {
    const strip = page.getByTestId("now-strip");
    await expect(strip).toHaveAttribute("data-count", "0");
    await expect(strip.getByTestId("now-strip-empty")).toHaveText(
      "Nothing needs you."
    );
    // The targets are genuinely open — the empty Now is the ranking, not an
    // absence of data. Their readings stand, and their log offers are still one
    // tap away under Show everything.
    const readings = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="target.weekly-progress:"]'
    );
    await expect(readings).toHaveCount(NOW_QUIET_TARGETS.length);
    const offers = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="target.log:"]'
    );
    await expect(offers).toHaveCount(NOW_QUIET_TARGETS.length);
    for (let i = 0; i < NOW_QUIET_TARGETS.length; i++) {
      await expect(offers.nth(i)).toHaveAttribute("data-lane", "everything");
    }
  } finally {
    await page.context().close();
  }
});

// #4841 item 2 — THE ACT ROW SAYS ITS VERB ONCE AND NAMES ITS TARGET.
//
// From the owner's phone screenshot: "Log cardio · 0 of 2 this week · Log". The row's
// label was `Log ${scope_value}` beside an action that also read "Log", so the row
// printed the verb twice and named its subject by the STORED KEY — which is why the
// screenshot showed "Lower" and "Chest" capitalised beside "cardio" and "berries".
//
// Now Quiet's two open targets are strength GROUPS, whose stored keys ("Lower",
// "Upper") are exactly the shape that read wrong; `cadenceScopeNoun` turns them into
// "Lower body" / "Upper body". The verb count is taken over the ROW'S OWN text, which
// is the thing the reader sees twice — an assertion on the action alone would have
// stayed green through the whole defect, because the action was always right.
test("a frequency-target act row names its target and says Log once", async ({
  browser,
}) => {
  const page = await openDashboard(browser, { username: E2E_LOGIN_NOWQUIET });
  try {
    await openDashboardAll(page);
    // ADDRESSED BY IDENTITY, NEVER BY THE WORDS UNDER TEST. Filtering the rows by
    // "Lower body" would make the whole check vanish on the broken tree — zero rows,
    // zero assertions, and a red that says nothing about the label or the verb.
    const rows = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="target.log:"]'
    );
    await expect(rows).toHaveCount(NOW_QUIET_TARGETS.length);
    // The NOUN, exactly, cased by `cadenceScopeNoun`: "Log Lower" and "Lower" both
    // fail this. Sorted, because the habit order is not this test's subject.
    expect(
      (await rows.getByTestId("standing-label").allInnerTexts()).sort()
    ).toEqual(["Lower body", "Upper body"]);
    // ONE verb per row, and it is the action's. Counted over the row's whole
    // rendered text rather than over any one element, because "twice" was a fact
    // about the ROW: before the fix this read 2.
    //
    // `innerText` AND NOT `textContent`, and that is the assertion's correctness
    // rather than a preference: textContent concatenates the detail straight onto
    // the action ("…this weekLog"), destroying the word boundary the count is keyed
    // on — measured here, where the textContent spelling counted 0 on the FIXED tree
    // and 1 on the broken one, i.e. exactly backwards.
    for (const shown of await rows.allInnerTexts())
      expect(shown.match(/\bLog\b/g)?.length ?? 0).toBe(1);
  } finally {
    await page.context().close();
  }
});

// ── The behind week: #3245, #3543 and #3548 on one fixture ──────────────────────────
//
// PACE_BEHIND sits on day 4 with two untouched 2x/week strength-group targets, so
// `frequencyPace` reads BEHIND and neither target has a rhythm moment. That is the
// exact state #3245 was filed about: before the ruling both log offers went straight
// back into Now from day 4 of every week.
test("a behind target tells its pace in Standing and takes no Now slot", async ({
  browser,
}) => {
  const page = await openDashboard(browser, { username: E2E_LOGIN_PACEBEHIND });
  try {
    // #3245: the log offers are still one tap away, and not in Now.
    const offers = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="target.log:"]'
    );
    await expect(offers).toHaveCount(PACE_BEHIND_TARGETS.length);
    for (let i = 0; i < PACE_BEHIND_TARGETS.length; i++)
      await expect(offers.nth(i)).toHaveAttribute("data-lane", "everything");

    // #3543: the reading states the pace, as a WORD. Exact match with a count, so a
    // neighbouring string that happens to contain "Behind" cannot satisfy it.
    const pace = page.getByTestId("standing-pace");
    await expect(pace).toHaveCount(PACE_BEHIND_TARGETS.length);
    for (let i = 0; i < PACE_BEHIND_TARGETS.length; i++)
      await expect(pace.nth(i)).toHaveText("Behind");

    // #3548: and it is the attention tier that carries it.
    const tier = page.locator('[data-standing-band="attention"]');
    await expect(
      tier.locator(
        '[data-testid="dashboard-candidate"][data-candidate-id^="target.weekly-progress:"]'
      )
    ).toHaveCount(PACE_BEHIND_TARGETS.length);
    await expect(tier.getByTestId("standing-pace")).toHaveCount(
      PACE_BEHIND_TARGETS.length
    );

    // And the point of the whole ruling: with the pace told where it belongs, day 4
    // of the week is a settled day again.
    const strip = page.getByTestId("now-strip");
    await expect(strip).toHaveAttribute("data-count", "0");
    await expect(strip.getByTestId("now-strip-empty")).toHaveText(
      "Nothing needs you."
    );
  } finally {
    await page.context().close();
  }
});

test("Attention keeps a full-band cue and readable header in both themes", async ({
  browser,
}) => {
  for (const colorScheme of ["light", "dark"] as const) {
    const page = await openDashboard(
      browser,
      { username: E2E_LOGIN_PACEBEHIND },
      { ...DESKTOP, colorScheme }
    );
    try {
      const tier = page.locator('[data-standing-band="attention"]');
      await expect(tier).toBeVisible();
      const paint = await tier.evaluate((node) => {
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true })!;
        const luminance = (color: string) => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const channels = context.getImageData(0, 0, 1, 1).data.slice(0, 3);
          const [red, green, blue] = Array.from(channels, (channel) => {
            const value = channel / 255;
            return value <= 0.03928
              ? value / 12.92
              : ((value + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
        };
        const style = getComputedStyle(node);
        const header = getComputedStyle(node.querySelector("h3")!);
        const foreground = luminance(header.color);
        const background = luminance(style.backgroundColor);
        return {
          background: style.backgroundColor,
          surrounding: getComputedStyle(node.parentElement!).backgroundColor,
          edge: Number.parseFloat(style.borderInlineStartWidth),
          contrast:
            (Math.max(foreground, background) + 0.05) /
            (Math.min(foreground, background) + 0.05),
        };
      });
      expect(paint.background).not.toBe(paint.surrounding);
      expect(paint.edge).toBeGreaterThanOrEqual(4);
      expect(paint.contrast).toBeGreaterThanOrEqual(4.5);
    } finally {
      await page.context().close();
    }
  }
});

// The negative control, and the reason the day-1 fixture stayed pinned: an on-pace
// target's reading is the quiet count it always was, in the stable rest.
test("an on-pace target states no pace and stays out of the tier", async ({
  browser,
}) => {
  const page = await openDashboard(browser, { username: E2E_LOGIN_NOWQUIET });
  try {
    const readings = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="target.weekly-progress:"]'
    );
    await expect(readings).toHaveCount(NOW_QUIET_TARGETS.length);
    await expect(page.getByTestId("standing-pace")).toHaveCount(0);
    await expect(
      page.locator(
        '[data-standing-band="attention"] [data-candidate-id^="target.weekly-progress:"]'
      )
    ).toHaveCount(0);
    await expect(
      page.locator(
        '[data-standing-band="rest"] [data-candidate-id^="target.weekly-progress:"]'
      )
    ).toHaveCount(NOW_QUIET_TARGETS.length);
  } finally {
    await page.context().close();
  }
});

// #3548's cold start, and the one profile that can show it: WHATS_NEW carries no
// health data at all, so every family is never-recorded and the attention tier IS
// the getting-started list. "Nothing needs you." may not render over it.
test("a cold-start profile's tier is the getting-started list", async ({
  browser,
}) => {
  const page = await openDashboard(browser, { username: E2E_LOGIN_WHATSNEW });
  try {
    const ctas = page.locator(
      '[data-standing-band="attention"] [data-testid="dashboard-candidate"][data-presence="never"]'
    );
    const shown = await ctas.count();
    expect(shown).toBeGreaterThanOrEqual(2);
    expect(shown).toBeLessThanOrEqual(3);
    await expect(page.getByTestId("now-strip-empty")).toHaveCount(0);
    // The strip's own heading and the day's orientation are untouched — this is one
    // page growing from onboarding, not a separate onboarding layout.
    await expect(
      page
        .getByTestId("now-strip")
        .getByRole("heading", { level: 2, name: "Right now", exact: true })
    ).toBeVisible();
    await expect(page.getByTestId("now-strip-date")).toBeVisible();
    // Past the cap the remaining CTAs are folded, not dropped — and since #4232 the
    // fold is the page's one bottom fold, in the Setup group the partition routes a
    // never-recorded candidate to.
    await expect(
      page
        .getByTestId("dashboard-everything-setup")
        .locator('[data-testid="dashboard-candidate"][data-presence="never"]')
    ).not.toHaveCount(0);
    await openDashboardAll(page);
    const vitals = page.locator('[data-candidate-id="vitals.bootstrap"]');
    await expect(vitals).toContainText("Vitals");
    await vitals.getByRole("button", { name: "Log a vital" }).click();
    const quickEntry = page.getByTestId("quick-entry-body");
    await expect(quickEntry).toHaveAttribute("data-form", "measurements");
    await expect(
      quickEntry.locator("#measurements-group-vitals-fields")
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

// The other half of the cold-start ruling: a CTA's claim is SPENT by recording.
// One weigh-in and the getting-started list retires into the fold on the next
// render, with the new reading standing where the instrument panel keeps it. One
// mechanism, no threshold cliff, no separate onboarding layout to leave.
test("the first log retires the getting-started list to the fold", async ({
  browser,
}) => {
  const before = await openDashboard(browser, {
    username: E2E_LOGIN_WHATSNEW,
  });
  const tierCtas = (page: Page) =>
    page.locator(
      '[data-standing-band="attention"] [data-testid="dashboard-candidate"][data-presence="never"]'
    );
  try {
    await expect(tierCtas(before)).not.toHaveCount(0);
  } finally {
    await before.context().close();
  }

  const cleanup = insertFirstWeighIn(E2E_LOGIN_WHATSNEW);
  try {
    const after = await openDashboard(browser, {
      username: E2E_LOGIN_WHATSNEW,
    });
    try {
      await expect(
        after.locator(
          '[data-standing-band="rest"] [data-standing-family="weight"]'
        )
      ).toBeVisible();
      await expect(tierCtas(after)).toHaveCount(0);
      // Retired, not dropped: every one of them is still in the document, in the
      // page's one fold, reachable (#4232).
      await expect(
        after
          .getByTestId("dashboard-everything-setup")
          .locator('[data-testid="dashboard-candidate"][data-presence="never"]')
      ).not.toHaveCount(0);
    } finally {
      await after.context().close();
    }
  } finally {
    cleanup();
  }
});

// ── The visual layer on a phone (#3252 / #3238) ─────────────────────────────────────

test("the Standing sparkline column is absent below 720px", async ({
  browser,
}) => {
  // The column is desktop-only BY RULING: mobile and desktop expose identical facts in
  // identical order, so the plot may never be the only carrier of anything. 390 is a
  // phone and 1280 is a desktop; the seam is at 720 and no dashboard fixture sits
  // between them.
  const phone = await openDashboard(browser, { username: E2E_LOGIN_DAILY });
  try {
    const standing = phone.getByTestId("dashboard-standing");
    await expect(standing).toBeVisible();
    const drawn = await standing
      .getByTestId("standing-sparkline")
      .evaluateAll(
        (nodes) =>
          nodes.filter((node) => getComputedStyle(node).display !== "none")
            .length
      );
    expect(drawn).toBe(0);
    // The facts themselves stand alone, unchanged.
    await expect(
      phone.locator(
        '[data-testid="dashboard-candidate"][data-candidate-id^="weight.latest:"]'
      )
    ).toBeVisible();
  } finally {
    await phone.context().close();
  }
});

test("Now's header is visible on a phone too, above the empty sentence", async ({
  browser,
}) => {
  // See the fixture note above: the settled sentence needs a settled profile now.
  const page = await openDashboard(browser, { username: E2E_LOGIN_NOWQUIET });
  try {
    const strip = page.getByTestId("now-strip");
    await expect(
      strip.getByRole("heading", { level: 2, name: "Right now", exact: true })
    ).toBeVisible();
    // The empty state's own sentence is unchanged under it (#3238).
    await expect(strip.getByTestId("now-strip-empty")).toHaveText(
      "Nothing needs you."
    );
  } finally {
    await page.context().close();
  }
});

test("the illness cockpit names its situation exactly once at 390px (#3238)", async ({
  browser,
}) => {
  const page = await openDashboard(browser, { username: E2E_LOGIN_SICK_SELF });
  try {
    const cockpit = page.locator("[data-testid^='illness-cockpit-']").first(); // first-ok: the acting profile's own cockpit leads the group
    await expect(cockpit).toBeVisible();
    const situation = (await cockpit.getAttribute("data-situation"))!;
    expect(situation.length).toBeGreaterThan(0);
    const header = cockpit.getByTestId("illness-cockpit-header-row");
    const text = (await header.innerText()).replace(/\s+/g, " ");
    const occurrences = text.split(situation).length - 1;
    expect(
      occurrences,
      `the header row says "${situation}" ${occurrences} times: ${text}`
    ).toBe(1);
    // The day survives — it is the situation's NAME that was doubled, not the day.
    await expect(cockpit.getByTestId("illness-cockpit-day")).toHaveText(
      /^Day \d+$/
    );

    const actions = ["note-toggle", "clear"].map((id) =>
      cockpit.getByTestId(`symptom-cough-${id}`)
    );
    await expectPhoneTapTargets(page, "logged symptom actions", actions, {
      disjoint: true,
    });
  } finally {
    await page.context().close();
  }
});

// ── Phone density (#3460) and the gutter glyph's phone ruling (#3459 item 3) ─────
//
// Every claim below is GEOMETRY at 390px, measured against the same page the
// desktop suite measures at 1280 — because "denser on a phone, untouched on the
// desktop" is two assertions, and only the pair of them says what was ruled.

/** Phone and desktop are two halves of ONE ruling, so they are asserted together. */
const ATOM_VIEWPORTS = [
  { label: "phone", size: { width: 390, height: 844 }, oneLine: true },
  { label: "desktop", size: { width: 1280, height: 900 }, oneLine: false },
] as const;

// ONE GUTTER, ONE ROW, AT EVERY WIDTH (#3460/#3920, restated for #4076). The atom
// this used to measure — a card with its own frame, its own inset row and a glyph in
// a desktop gutter beside it — is gone: Now renders the shared row like every other
// zone. What the ruling was actually about survives and is what is measured here.
//
// THE CLAIM IS A RELATIONSHIP FIRST AND AN ABSOLUTE SECOND, which is #3920's lesson
// stated on this surface: "the label is at 16px" is satisfied exactly by the broken
// tree where the fill is inset and the text is flush against its own edge. So the
// first assertion is text-to-ITS-OWN-FILL — the label sits one row gutter inside the
// band, at every width — and the page-rag absolute is asserted only below `sm`,
// where the band bleeds and the two answers coincide. Above `sm` the band keeps its
// frame, so the label sits a border plus a gutter inside it and the absolute would
// be a different, wrong claim.
test("a Now row puts its label and detail on one line, one gutter inside its own band", async ({
  page,
}) => {
  for (const viewport of ATOM_VIEWPORTS) {
    await page.setViewportSize(viewport.size);
    await page.goto("/");
    const row = page
      .locator('[data-testid="dashboard-candidate"][data-lane="now"]')
      .filter({ has: page.getByTestId("attention-item-detail") })
      .first(); // first-ok: every Now row is laid out by the same renderer
    await expect(row).toBeVisible();
    // Wait for the DETAIL, not the row: the thing being measured is the flow between
    // two elements, and a row that has only painted its label would let this pass by
    // measuring nothing.
    await expect(row.getByTestId("attention-item-detail")).toBeVisible();

    const geometry = await row.evaluate((node) => {
      const strip = document
        .querySelector('[data-testid="now-strip"]')!
        .getBoundingClientRect();
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const label = node
        .querySelector('[data-testid="standing-label"]')!
        .getBoundingClientRect();
      const detail = node
        .querySelector('[data-testid="attention-item-detail"]')!
        .getBoundingClientRect();
      return {
        stripLeft: strip.left,
        rowContentLeft:
          box.left +
          Number.parseFloat(style.borderLeftWidth) +
          Number.parseFloat(style.paddingLeft),
        rowGutter: Number.parseFloat(style.paddingLeft),
        labelLeft: label.left,
        labelTop: label.top,
        detailLeft: detail.left,
        detailTop: detail.top,
        icons: node.querySelectorAll('[data-testid="standing-label"] svg')
          .length,
      };
    });

    // THE RELATIONSHIP: the label starts exactly at the row's content edge — never
    // flush against the fill it is printed on, and never a second inset in from it.
    expect(
      geometry.labelLeft,
      `label at ${geometry.labelLeft}, row content edge at ${geometry.rowContentLeft}`
    ).toBeCloseTo(geometry.rowContentLeft, 0);
    expect(geometry.rowGutter).toBeGreaterThan(0);

    // THE ABSOLUTE, below `sm` only: the band bleeds the page gutter outward and the
    // row re-spends it inward, so the label lands on the page's own left rag.
    if (viewport.oneLine)
      expect(
        geometry.labelLeft - geometry.stripLeft,
        `label sits ${geometry.labelLeft - geometry.stripLeft}px from the page rag`
      ).toBeCloseTo(0, 0);

    // Label and detail share the line, at every width: the row IS the one-line form.
    expect(geometry.detailLeft).toBeGreaterThan(geometry.labelLeft);
    expect(Math.abs(geometry.detailTop - geometry.labelTop)).toBeLessThan(8);
    // And no glyph rides beside the words that identify the row (#4076).
    expect(geometry.icons).toBe(0);
  }
});

test("no Now-card control gives up its declared tap floor at 390px", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByTestId("now-strip")).toBeVisible();
  const audit = await page.evaluate(() => {
    const floored: string[] = [];
    const menus: string[] = [];
    const short: string[] = [];
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()}[${el.getAttribute("data-testid") ?? (el.textContent ?? "").trim().slice(0, 20)}]`;
    for (const card of Array.from(
      // EVERY row in the strip, the illness cockpit's included: the cockpit is the
      // one entry that is not a fact, and its toggle is exactly the control this
      // audit exists for.
      document.querySelectorAll('[data-testid="now-strip"] > ul > li')
    )) {
      for (const el of Array.from(
        card.querySelectorAll("a, button, [role='button']")
      )) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) continue;
        // A DECLARED floor must SURVIVE: an ancestor that squeezes one, or a lost
        // declaration, is the regression a density pass could plausibly introduce.
        // The two cockpit controls named below now declare `min-h-11` (44px) —
        // #3514 ruled one tap floor at 44 effective and they took the RENDERED
        // mechanism. This threshold stays at 40 on purpose: it is the "does this
        // element declare a floor at all" filter, not the floor itself, and
        // lowering the bar for MEMBERSHIP is what keeps it seeing a control that
        // has drifted DOWN to 40 rather than quietly dropping it from the census.
        const floor = parseFloat(getComputedStyle(el).minHeight);
        if (floor >= 40) {
          floored.push(name(el));
          if (box.height < floor - 0.5)
            short.push(
              `${name(el)} declares ${floor}px and renders ${box.height}px`
            );
        }
        // The row's overflow menu is a 40x40 target in its own right (#644).
        if (el.getAttribute("data-testid") === "overflow-menu-trigger") {
          menus.push(name(el));
          if (box.width < 39.5 || box.height < 39.5)
            short.push(`${name(el)} is ${box.width}x${box.height}`);
        }
      }
    }
    return { floored, menus, short };
  });

  // THE SWEEP MUST HAVE SEEN THE CONTROLS IT IS ABOUT. A Now strip whose cards
  // declared no floor at all would pass an empty-set check silently, which is the
  // shape of green this issue was opened over — so the two KINDS of floored
  // control the strip carries are named rather than counted. Kinds, not elements:
  // how MANY cockpit cards a fixture seeds varies, what they declare does not.
  expect(
    audit.floored.some((entry) => entry.includes("illness-cockpit-toggle")),
    `no floored cockpit toggle among: ${audit.floored.join(", ") || "(none)"}`
  ).toBe(true);
  expect(
    audit.floored.some((entry) =>
      entry.includes("illness-cockpit-full-episode")
    ),
    `no floored episode link among: ${audit.floored.join(", ") || "(none)"}`
  ).toBe(true);
  expect(
    audit.menus.length,
    "no Now card carried an overflow menu to measure"
  ).toBeGreaterThan(0);
  expect(audit.short, audit.short.join("\n")).toEqual([]);
});

// #3460's claim, restated for the band (#4076). The strip used to be a GRID of cards
// whose row-gap it tightened on a phone; it is a band of rows now, so the separation
// is a divider and there is no gap to tighten. What survives unchanged is the
// section's own rhythm under the strip, which is what #3460 was buying: every unit it
// keeps pushes the first reading further down a 390px page.
test("the strip's own rhythm is tighter on a phone and unchanged on the desktop", async ({
  browser,
}) => {
  for (const [options, margin] of [
    [PHONE, "16px"],
    [DESKTOP, "24px"],
  ] as const) {
    const page = await openDashboard(
      browser,
      { username: E2E_LOGIN_NOWSTRIP },
      options
    );
    try {
      const strip = page.getByTestId("now-strip");
      const rows = strip.locator(
        '[data-testid="dashboard-candidate"][data-lane="now"]'
      );
      // The control: the band drew more than one row, so the divider claim below is
      // about a real seam and not about a single row's top border.
      expect(await rows.count()).toBeGreaterThan(1);
      const chrome = await strip.evaluate((section) => {
        const row = section.querySelector<HTMLElement>(
          '[data-testid="dashboard-candidate"][data-lane="now"]:nth-child(2)'
        )!;
        return {
          margin: getComputedStyle(section).marginBottom,
          gap: getComputedStyle(row.parentElement!).rowGap,
          seam: getComputedStyle(row).borderTopWidth,
        };
      });
      // Rows are separated by a DIVIDER, not by a gap — a band, not a card stack.
      expect(chrome.gap).toBe("normal");
      expect(Number.parseFloat(chrome.seam)).toBeGreaterThan(0);
      expect(chrome.margin).toBe(margin);
    } finally {
      await page.context().close();
    }
  }
});

test("the illness cockpit keeps every section at 390px, on the stepped-down seams", async ({
  browser,
}) => {
  for (const [options, seam] of [
    [PHONE, "12px"],
    [DESKTOP, "16px"],
  ] as const) {
    const page = await openDashboard(
      browser,
      { username: E2E_LOGIN_SICK_SELF },
      options
    );
    try {
      const cockpit = page.getByTestId("illness-cockpit-body").first(); // first-ok: the acting profile's own cockpit leads the group
      await expect(cockpit).toBeVisible();
      // NOTHING WAS REMOVED — this is a spacing pass over a safety surface, and
      // the content set is a ruling it may not touch.
      await expect(cockpit.getByTestId("symptom-day-primary")).toBeVisible();
      await expect(cockpit.getByTestId("temp-quick-toggle")).toBeVisible();
      await expect(cockpit.getByTestId("cockpit-prn")).toBeVisible();
      await expect(cockpit.getByTestId("cockpit-end-episode")).toBeVisible();

      // EVERY SEAM, not one of them. The cockpit's rhythm is carried by each
      // ruled section boundary, and a guard that read only `cockpit-prn` would
      // have left the others free to drift. Seams are found by their own border
      // rather than by testid, so a section that is conditional — the stale
      // nudge does not render for every episode — is covered when it renders and
      // cannot fail the guard when it does not.
      //
      // TWO OF THE FOUR SEAMS ARE GONE, AND THAT IS #4752 (item 1). The readings
      // band became the recovery HEADER, which opens the card and so rules
      // nothing above it; the footer band held "Feeling better", which is now
      // promoted into that header beside the countdown. The floor below names
      // the two that remain unconditional rather than counting, because a count
      // is what would have gone quiet when the population changed under it.
      const rhythm = await cockpit.evaluate((body) => {
        const seams = Array.from(body.children)
          .map((child) => ({ child, style: getComputedStyle(child) }))
          .filter(
            ({ style }) =>
              parseFloat(style.borderTopWidth) > 0 ||
              parseFloat(style.borderBottomWidth) > 0
          )
          .map(({ child, style }) => ({
            what:
              child.getAttribute("data-testid") ?? child.tagName.toLowerCase(),
            // A band that CLOSES a section pads below it; one that OPENS a
            // section pads above. Both are the same ruled unit.
            edge:
              parseFloat(style.borderTopWidth) > 0
                ? `${style.marginTop}/${style.paddingTop}`
                : `${style.marginBottom}/${style.paddingBottom}`,
          }));
        return { seams };
      });
      // The sweep must have found the seams it is about: the symptom section and
      // the med block both render for every writable cockpit.
      expect(
        rhythm.seams.map((entry) => entry.what),
        `seams found: ${JSON.stringify(rhythm.seams)}`
      ).toEqual(expect.arrayContaining(["section", "cockpit-prn"]));
      expect(
        rhythm.seams.map((entry) => entry.edge),
        JSON.stringify(rhythm.seams)
      ).toEqual(rhythm.seams.map(() => `${seam}/${seam}`));
      if (options === PHONE) await expectNoClippedContent(page);
    } finally {
      await page.context().close();
    }
  }
});
