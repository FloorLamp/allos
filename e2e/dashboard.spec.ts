import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import {
  E2E_LOGIN_DAILY,
  E2E_LOGIN_DASHBOARD_ALL,
  E2E_LOGIN_SICK_SELF,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import { openDashboardAll, settledBoxes, settledClick } from "./helpers";

function resetDashboardAllOffer(): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare(
        `SELECT p.id
           FROM profiles p
           JOIN login_profiles lp ON lp.profile_id = p.id
           JOIN logins l ON l.id = lp.login_id
          WHERE l.username = ?`
      )
      .get(E2E_LOGIN_DASHBOARD_ALL) as { id: number };
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE profile_id = ? AND signal_key LIKE 'stream-onboard:%'"
    ).run(profile.id);
    db.prepare(
      "DELETE FROM profile_settings WHERE profile_id = ? AND key = 'wear_reminder_enabled'"
    ).run(profile.id);
  } finally {
    db.close();
  }
}

function setSecondDashboardNap(enabled: boolean): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const seededNap = db
      .prepare(
        `SELECT profile_id, date, started_at
           FROM metric_samples
          WHERE profile_id = (SELECT MIN(id) FROM profiles)
            AND metric = 'sleep_min'
            AND value = 45
          ORDER BY date DESC
          LIMIT 1`
      )
      .get() as { profile_id: number; date: string; started_at: string };
    const start = new Date(
      new Date(seededNap.started_at).getTime() - 2 * 60 * 60_000
    );
    const end = new Date(start.getTime() + 30 * 60_000);
    db.prepare(
      `DELETE FROM metric_samples
        WHERE profile_id = ?
          AND source = 'manual'
          AND origin IS NULL
          AND metric = 'sleep_min'
          AND started_at = ?`
    ).run(seededNap.profile_id, start.toISOString());
    if (!enabled) return;
    db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, started_at, ended_at, value)
       VALUES (?, 'manual', NULL, 'sleep_min', ?, ?, ?, 30)`
    ).run(
      seededNap.profile_id,
      seededNap.date,
      start.toISOString(),
      end.toISOString()
    );
  } finally {
    db.close();
  }
}

test("the dashboard renders the fixed four-zone instrument cluster", async ({
  page,
}) => {
  await page.goto("/");
  const main = page.getByRole("main");

  await expect(main.getByTestId("now-strip")).toBeVisible();
  await expect(main.getByTestId("dashboard-standing")).toBeVisible();
  const standing = main.getByTestId("dashboard-standing");
  expect(
    await standing
      .locator("[data-standing-section]")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-standing-section"))
      )
  ).toEqual(["today", "body", "longer-view"]);
  await expect(
    standing.locator('[data-standing-section="today"]')
  ).toBeVisible();
  await expect(
    standing.locator('[data-standing-section="body"]')
  ).toBeVisible();
  await expect(
    standing.locator('[data-standing-section="longer-view"]')
  ).toBeVisible();
});

test("attention facts use write-capable atoms outside read-only Ahead", async ({
  page,
}) => {
  await page.goto("/");
  const facts = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="attention.fact:"]'
  );
  const count = await facts.count();

  expect(count).toBeGreaterThan(1);
  for (let index = 0; index < count; index += 1) {
    const fact = facts.nth(index);
    const lane = await fact.getAttribute("data-lane");
    await expect(fact.getByTestId("dashboard-attention-atom")).toHaveCount(
      lane === "ahead" ? 0 : 1
    );
  }
});

test("clinical results render as dense individual facts", async ({ page }) => {
  await page.goto("/");
  const main = page.getByRole("main");
  const family = main.locator('[data-standing-family="clinical-results"]');
  const rows = family.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="labs.latest:"]'
  );

  expect(await rows.count()).toBeGreaterThan(1);
  await expect(
    family.getByText("Recent clinical results", { exact: true })
  ).toBeVisible();
});

test("ordinary other-profile attention stays off the acting dashboard", async ({
  page,
}) => {
  await page.goto("/");
  const facts = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="household.attention:"]'
  );
  await expect(facts).toHaveCount(0);
});

test("Ahead expands by keyboard without opening Show everything", async ({
  page,
}) => {
  await page.goto("/");
  const ahead = page.getByTestId("dashboard-ahead");
  await expect(ahead).toBeVisible();
  const horizon = ahead.locator('[data-ahead-bucket="horizon"]');
  const expander = horizon.getByRole("button", {
    name: /^\+\d+ more in This week and later$/,
  });
  const controlled = await expander.getAttribute("aria-controls");
  expect(controlled).toBeTruthy();
  await expect(expander).toHaveAccessibleName(
    /^\+\d+ more in This week and later$/
  );
  await expect(expander).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`#${controlled}`)).toBeHidden();
  await expander.focus();
  await expander.press("Enter");
  await expect(expander).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(`#${controlled}`)).toBeVisible();
  await expander.press("Space");
  await expect(expander).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(`#${controlled}`)).toBeHidden();
  await expect(page.getByTestId("dashboard-all")).not.toHaveAttribute(
    "open",
    ""
  );
});

test("Show everything remembers its open state on this device", async ({
  browser,
}) => {
  resetDashboardAllOffer();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DASHBOARD_ALL,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const details = page.getByTestId("dashboard-all");
    await expect(details).not.toHaveAttribute("open", "");
    await openDashboardAll(page);
    await page.addInitScript(() => {
      const state = window as typeof window & {
        __dashboardAllOpenAtFirstFrame?: boolean;
      };
      const sampleFirstFrame = () => {
        const disclosure = document.querySelector<HTMLDetailsElement>(
          '[data-testid="dashboard-all"]'
        );
        if (disclosure) {
          state.__dashboardAllOpenAtFirstFrame = disclosure.open;
          return;
        }
        requestAnimationFrame(sampleFirstFrame);
      };
      requestAnimationFrame(sampleFirstFrame);
    });
    await page.reload();
    await expect(details).toHaveAttribute("open", "");
    await expect(page.getByTestId("dashboard-all-contents")).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __dashboardAllOpenAtFirstFrame?: boolean;
              }
            ).__dashboardAllOpenAtFirstFrame
        )
      )
      .toBe(true);

    await settledClick(page, page.getByTestId("stream-offer-decline-onboard"));
    await expect(page.getByTestId("stream-lifecycle-offers")).toHaveCount(0);
  } finally {
    resetDashboardAllOffer();
    await page.context().close();
  }
});

test("manual and external readings are both eligible for Standing", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DAILY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const manual = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="weight.latest:"]'
    );
    const external = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="activity.steps:"]'
    );

    await expect(manual).toHaveAttribute("data-engagement", "manual");
    await expect(manual).toHaveAttribute("data-lane", "standing");
    await expect(external).toHaveAttribute("data-engagement", "external");
    await expect(external).toHaveAttribute("data-lane", "standing");
  } finally {
    await page.context().close();
  }
});

test("mobile and desktop expose the same four-zone fact order", async ({
  page,
}) => {
  await page.goto("/");
  const facts = page.getByRole("main").getByTestId("dashboard-candidate");
  const desktop = await facts.evaluateAll((nodes) =>
    nodes.map(
      (node) =>
        `${node.getAttribute("data-lane")}:${node.getAttribute("data-fact-key")}`
    )
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await facts.evaluateAll((nodes) =>
    nodes.map(
      (node) =>
        `${node.getAttribute("data-lane")}:${node.getAttribute("data-fact-key")}`
    )
  );
  expect(mobile).toEqual(desktop);
});

test("one nap produces one Standing total and keeps the individual outside Standing", async ({
  page,
}) => {
  await page.goto("/");
  const total = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap-total:"]'
  );
  const naps = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap:"]'
  );
  await expect(total).toHaveAttribute("data-lane", "standing");
  await expect(total).toContainText("1 nap");
  const napCount = await naps.count();
  expect(napCount).toBeLessThanOrEqual(1);
  for (let index = 0; index < napCount; index += 1) {
    await expect(naps.nth(index)).not.toHaveAttribute("data-lane", "standing");
  }
});

test("multiple naps produce one Standing total and keep individuals outside Standing", async ({
  page,
}) => {
  setSecondDashboardNap(true);
  try {
    await page.goto("/");
    const total = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap-total:"]'
    );
    const naps = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap:"]'
    );
    await expect(total).toHaveAttribute("data-lane", "standing");
    await expect(total).toContainText("1h 15m");
    await expect(total).toContainText("2 naps");
    const napCount = await naps.count();
    expect(napCount).toBeGreaterThanOrEqual(1);
    expect(napCount).toBeLessThanOrEqual(2);
    await expect(
      page.locator(
        '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap:"][data-candidate-id$=":660"]'
      )
    ).not.toHaveAttribute("data-lane", "standing");
    for (let index = 0; index < napCount; index += 1) {
      await expect(naps.nth(index)).not.toHaveAttribute(
        "data-lane",
        "standing"
      );
    }
  } finally {
    setSecondDashboardNap(false);
  }
});

// The owner ruling of #3186, on the many-marker profile that provoked it: the
// dashboard renders the clinical family's capped membership and nothing else, and
// the readings it no longer names are still whole one tap away. Both halves matter
// — a test that only watched the dashboard shrink would pass if the data had been
// deleted instead of moved.
test("the clinical family renders its cap and /results keeps the census", async ({
  page,
}) => {
  await page.goto("/");
  const labs = page.locator(
    '[data-testid="dashboard-candidate"][data-candidate-id^="labs.latest:"]'
  );
  const lanes = await labs.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-lane"))
  );
  expect(lanes).toEqual(Array.from({ length: 6 }, () => "standing"));

  await page.goto("/results/clinical-results");
  // Each collapsed panel-group header states how many analytes the group holds,
  // whether or not its rows are expanded — so this is the whole census, not a page
  // of it.
  const groups = page
    .getByTestId("results-clinical-results")
    .getByTestId("clinical-result-panel-toggle");
  const census = (
    await groups.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("aria-label") ?? "")
    )
  ).reduce(
    (total, label) => total + Number(/(\d+) analytes?\b/.exec(label)?.[1] ?? 0),
    0
  );
  expect(census).toBeGreaterThan(lanes.length);
});

test("every applicable fact appears in exactly one atomic lane", async ({
  page,
}) => {
  await page.goto("/");
  const candidates = page
    .getByRole("main")
    .locator("[data-candidate-id][data-fact-key]");
  const identities = await candidates.evaluateAll((nodes) =>
    nodes.map((node) => ({
      candidateId: node.getAttribute("data-candidate-id"),
      factKey: node.getAttribute("data-fact-key"),
    }))
  );
  const candidateIds = identities.map(({ candidateId }) => candidateId);
  const factKeys = identities.map(({ factKey }) => factKey);
  expect(candidateIds.every(Boolean)).toBe(true);
  expect(new Set(candidateIds).size).toBe(candidateIds.length);
  expect(factKeys.every(Boolean)).toBe(true);
  expect(new Set(factKeys).size).toBe(factKeys.length);
});

test("illness identities stay exact-once when the cockpit folds", async ({
  browser,
}) => {
  const page = await loginAs(
    browser,
    { username: E2E_LOGIN_SICK_SELF, password: E2E_MEMBER_PASSWORD },
    { viewport: { width: 390, height: 844 }, hasTouch: true }
  );
  try {
    await page.goto("/");
    const main = page.getByRole("main");
    const cockpit = main
      .getByTestId("illness-now-group")
      .locator('[data-active="true"]');
    await expect(cockpit).toHaveCount(1);

    const illnessIdentities = async () =>
      main
        .locator('[data-candidate-id^="illness."][data-fact-key^="illness."]')
        .evaluateAll((nodes) =>
          nodes.map((node) => ({
            candidateId: node.getAttribute("data-candidate-id")!,
            factKey: node.getAttribute("data-fact-key")!,
          }))
        );
    const expectExactOnce = (
      identities: Awaited<ReturnType<typeof illnessIdentities>>
    ) => {
      expect(
        identities.some(({ candidateId }) =>
          candidateId.startsWith("illness.state:")
        )
      ).toBe(true);
      expect(
        identities.some(({ candidateId }) =>
          candidateId.startsWith("illness.temperature:")
        )
      ).toBe(true);
      expect(
        new Set(identities.map(({ candidateId }) => candidateId)).size
      ).toBe(identities.length);
      expect(new Set(identities.map(({ factKey }) => factKey)).size).toBe(
        identities.length
      );
    };

    const expanded = await illnessIdentities();
    expectExactOnce(expanded);
    await settledClick(
      page,
      cockpit.locator('[data-testid^="illness-cockpit-toggle-"]')
    );
    await expect(cockpit).toHaveAttribute("data-expanded", "false");
    const collapsed = await illnessIdentities();
    expectExactOnce(collapsed);
    expect(collapsed).toEqual(expanded);
  } finally {
    await page.context().close();
  }
});

// ── The visual layer (#3253 / #3252 / #3238) ────────────────────────────────────────
//
// Four decisions and a column, asserted where they are visible: the dashboard's
// declared width, the hover doors on Standing rows (mouse AND keyboard), one kind glyph
// per Now/Ahead card and none on any reading line, the desktop sparkline column, and
// the witnessed-only motion rule's QUIET half.

test("the dashboard declares its own width instead of filling the shell", async ({
  page,
}) => {
  await page.goto("/");
  const canvas = page.getByTestId("dashboard-canvas");
  await expect(canvas).toBeVisible();
  // `wide` — the existing 72rem token, not a hand-written cap.
  expect(await canvas.evaluate((node) => getComputedStyle(node).maxWidth)).toBe(
    "1152px"
  );
  // And it is genuinely narrower than the space it sits in at 1280, which is the
  // defect: "Mark taken" used to sit a monitor's width from its own card's title.
  const box = (await canvas.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(1152);
});

test("Now carries a visible header at its siblings' scale (#3238)", async ({
  page,
}) => {
  await page.goto("/");
  const main = page.getByRole("main");
  for (const name of ["Right now", "Standing"]) {
    await expect(
      main.getByRole("heading", { level: 2, name, exact: true })
    ).toBeVisible();
  }
  // The section's accessible name survives the move from aria-label to the heading.
  await expect(main.getByRole("region", { name: "Right now" })).toBeVisible();
  const sizes = await main
    .getByRole("heading", { level: 2 })
    .evaluateAll((nodes) =>
      nodes
        .filter((node) => ["Right now", "Standing"].includes(node.textContent!))
        .map((node) => getComputedStyle(node).fontSize)
    );
  expect(new Set(sizes).size).toBe(1);
});

test("a Standing row reveals its door on hover and on keyboard focus alike", async ({
  page,
}) => {
  await page.goto("/");
  const family = page
    .locator("[data-standing-family]:not([data-standing-trend])")
    .filter({ has: page.getByTestId("standing-door") })
    .first(); // first-ok: plotless families use the same two-column template
  const row = family
    .locator('[data-testid="dashboard-candidate"][data-lane="standing"]')
    .filter({ has: page.getByTestId("standing-door") })
    .first(); // first-ok: every doored row uses the same rail
  const link = row.getByRole("link").first(); // first-ok: the row above is one candidate; its link IS the row
  const door = row.getByTestId("standing-door");
  const opacity = (target: typeof door) =>
    target.evaluate((node) => getComputedStyle(node).opacity);

  // At rest the door is invisible and the row's own age text is not.
  await expect(door).toBeAttached();
  expect(await opacity(door)).toBe("0");
  // Settle the scroll position BEFORE measuring: `hover()` scrolls the row into view
  // on its own, and a boundingBox is viewport-relative, so an unscrolled baseline
  // would report the page's scroll as a 2,000px "layout shift".
  await link.scrollIntoViewIfNeeded();
  const before = (await link.boundingBox())!;

  await link.hover();
  await expect.poll(() => opacity(door)).toBe("1");

  // NO LAYOUT SHIFT: the exchange is opacity and transform only, so the row it
  // happens inside never moves or resizes.
  const during = (await link.boundingBox())!;
  expect(Math.abs(during.width - before.width)).toBeLessThan(1);
  expect(Math.abs(during.y - before.y)).toBeLessThan(1);

  // AND IT LANDS ON THE RAIL (#3459 item 2): the right edge of the family row's
  // facts cell, whichever member is hovered — not trailing whatever text this
  // member happens to end with. Polled rather than read once, because the door
  // slides 0.25rem on its way in and a single read can catch it mid-transition.
  await expect
    .poll(async () =>
      Math.round(
        await row.evaluate((li) => {
          const facts = li.closest("dd")!.getBoundingClientRect();
          const label = li
            .querySelector("[data-testid='standing-door']")!
            .getBoundingClientRect();
          return facts.right - label.right;
        })
      )
    )
    .toBe(0);
  expect(
    await family.evaluate((node) => {
      const style = getComputedStyle(node);
      return Math.round(
        node.getBoundingClientRect().right -
          parseFloat(style.paddingRight) -
          node.querySelector("dd")!.getBoundingClientRect().right
      );
    })
  ).toBe(0);

  // The IDENTICAL treatment from the keyboard. Move the mouse away first, so what is
  // being measured is focus and not a lingering hover.
  await page.mouse.move(0, 0);
  await expect.poll(() => opacity(door)).toBe("0");
  await link.focus();
  await expect.poll(() => opacity(door)).toBe("1");
});

test("a stacked family's door lands on the member you are pointing at, not on the stack", async ({
  page,
}) => {
  // THE `members` BRANCH, which nothing else exercises. A `single`/`composed`
  // family puts every member on ONE line, so anchoring its doors to the `ul` and
  // to the `li` are indistinguishable — and the door test above happens to pick a
  // `composed` row. A `members` family STACKS, so the two differ by the whole
  // height of the stack, and only here can the wrong anchor be seen.
  //
  // The rail assertion in the test above reads x ONLY, by construction: a door
  // anchored to the stack keeps the identical right edge and moves in y. So this
  // reads y.
  await page.goto("/");
  const family = page
    .locator('[data-standing-family][data-standing-composition="members"]')
    .filter({ has: page.getByTestId("standing-door") })
    .first(); // first-ok: every stacked family anchors its doors the same way
  await expect(family).toBeVisible();

  const doored = family
    .getByTestId("dashboard-candidate")
    .filter({ has: page.getByTestId("standing-door") });
  const count = await doored.count();
  // A one-member "stack" is not a stack: it would make this test green against
  // the very anchor it exists to reject, so the fixture must really stack.
  expect(count, "the stacked family under test has one member").toBeGreaterThan(
    1
  );

  // The LAST member — furthest from the top of the stack, so a door anchored to
  // the stack is furthest from where it belongs.
  const member = doored.nth(count - 1);
  const link = member.getByRole("link").first(); // first-ok: the member row IS its link
  await link.scrollIntoViewIfNeeded();
  await link.hover();
  const door = member.getByTestId("standing-door");
  await expect
    .poll(() => door.evaluate((n) => getComputedStyle(n).opacity))
    .toBe("1");

  const placed = await member.evaluate((li) => {
    const row = li.getBoundingClientRect();
    const stack = li.closest("ul")!.getBoundingClientRect();
    const label = li
      .querySelector("[data-testid='standing-door']")!
      .getBoundingClientRect();
    const facts = li.closest("dd")!.getBoundingClientRect();
    return {
      rowCentre: row.top + row.height / 2,
      rowHeight: row.height,
      stackHeight: stack.height,
      doorCentre: label.top + label.height / 2,
      doorHeight: label.height,
      railGap: facts.right - label.right,
    };
  });

  // The fixture must actually stack, or the assertions below cannot discriminate.
  expect(
    placed.stackHeight,
    `stack ${placed.stackHeight} vs row ${placed.rowHeight}`
  ).toBeGreaterThan(placed.rowHeight + 8);

  // ON THE MEMBER'S OWN LINE: same centre, and no taller than the line itself.
  expect(
    placed.doorCentre - placed.rowCentre,
    `door centre is ${placed.doorCentre - placed.rowCentre}px off the row it belongs to`
  ).toBeCloseTo(0, 0);
  expect(placed.doorHeight).toBeLessThanOrEqual(placed.rowHeight + 1);
  // And still on the rail — the x half, unchanged.
  expect(placed.railGap).toBeCloseTo(0, 0);
});

test("the shared rail answers with the row's primary door", async ({
  page,
}) => {
  // Every member of a family shares ONE door rail, so their door boxes overlap
  // exactly. If a door could take the pointer, the topmost — the last member in
  // the DOM — would answer for the whole rail, and hovering it would reveal that
  // member's door no matter which member the pointer was actually over.
  //
  // Paired with a PRESENCE check on purpose: an absence assertion that never had
  // a door to suppress would pass against a page with no doors at all.
  await page.goto("/");
  const family = page
    .locator('[data-standing-family][data-standing-composition="composed"]')
    .filter({ has: page.getByTestId("standing-door") })
    .first(); // first-ok: composed families all share one rail the same way
  await expect(family).toBeVisible();
  const doors = family.getByTestId("standing-door");
  expect(await doors.count()).toBeGreaterThan(1);
  const opacities = () =>
    doors.evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).opacity)
    );

  // PRESENCE: a member's own text does reveal that member's door.
  const first = family
    .getByTestId("dashboard-candidate")
    .filter({ has: page.getByTestId("standing-door") })
    .first(); // first-ok: the leading member, hovered to prove a door can appear
  await first.getByRole("link").first().hover(); // first-ok: the member row IS its link
  await expect.poll(async () => (await opacities()).includes("1")).toBe(true);

  // The widened primary link owns the rail; overlapping doors do not take pointer
  // events, so only that link's door appears.
  const rail = await family.evaluate((node) => {
    const facts = node.querySelector("dd")!.getBoundingClientRect();
    const list = node.querySelector("ul")!.getBoundingClientRect();
    return { x: facts.right - 5, y: list.top + list.height / 2 };
  });
  await page.mouse.move(rail.x, rail.y);
  await expect
    .poll(async () => (await opacities()).join(","))
    .toMatch(/^1(,0)*$/);
});

test("the Standing link covers its phone label and desktop plot without covering the date", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DAILY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const family = page
      .locator("[data-standing-family][data-standing-trend]")
      .filter({ has: page.locator(".standing-age") })
      .first(); // first-ok: plotted families share this row anatomy
    const row = family
      .getByTestId("dashboard-candidate")
      .filter({ has: page.locator(".standing-age") });
    const age = row.locator(".standing-age");
    const link = row.getByRole("link").first(); // first-ok: the selected candidate's link
    const door = link.getByTestId("standing-door");
    await link.scrollIntoViewIfNeeded();
    const before = (await family.boundingBox())!;
    const name = (await family.locator("dt").boundingBox())!;
    await page.mouse.move(name.x + name.width / 2, name.y + name.height / 2);
    await expect
      .poll(() => door.evaluate((node) => getComputedStyle(node).opacity))
      .toBe("1");
    const [ageBox, doorBox] = await settledBoxes([age, door]);
    expect(ageBox.x + ageBox.width).toBeLessThanOrEqual(doorBox.x + 1);
    expect(await family.boundingBox()).toEqual(before);

    const plot = (await family
      .getByTestId("standing-sparkline")
      .boundingBox())!;
    expect(
      await page.evaluate(
        ({ x, y }) =>
          document.elementFromPoint(x, y)?.closest("a")?.getAttribute("href"),
        { x: plot.x + plot.width / 2, y: plot.y + plot.height / 2 }
      )
    ).toBe(await link.getAttribute("href"));

    await page.setViewportSize({ width: 640, height: 844 });
    await page.goto("/");
    const midRow = page
      .locator('[data-candidate-id^="weight.latest:"]')
      .getByRole("link");
    await midRow.focus();
    await expect
      .poll(() =>
        midRow
          .getByTestId("standing-door")
          .evaluate((node) => getComputedStyle(node).opacity)
      )
      .toBe("1");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    const phoneFamily = page
      .locator("[data-standing-family]")
      .filter({ has: page.locator("a.standing-primary") })
      .first(); // first-ok: every primary surface uses the same mobile reach
    const phoneName = (await phoneFamily.locator("dt").boundingBox())!;
    const phoneHref = await phoneFamily
      .locator("a.standing-primary")
      .getAttribute("href");
    await page.mouse.click(
      phoneName.x + phoneName.width / 2,
      phoneName.y + phoneName.height / 2
    );
    await page.waitForURL((url) => `${url.pathname}${url.hash}` === phoneHref);
  } finally {
    await page.context().close();
  }
});

test("cards carry exactly one kind glyph and reading lines carry none", async ({
  page,
}) => {
  await page.goto("/");
  const main = page.getByRole("main");
  const cards = main.locator("[data-testid^='now-strip-card-']");
  const cardCount = await cards.count();
  expect(cardCount).toBeGreaterThan(0);
  for (let index = 0; index < cardCount; index += 1) {
    const glyph = cards.nth(index).locator("[data-kind-glyph]").first(); // first-ok: the nth card's own glyph; its count is asserted on the next line
    await expect(glyph).toBeAttached();
    // ONE glyph for the card itself. A nested candidate's own markup carries none,
    // so this count is the card's own.
    expect(await cards.nth(index).locator("[data-kind-glyph]").count()).toBe(1);
  }
  const ahead = main.getByTestId("dashboard-ahead");
  if ((await ahead.count()) > 0) {
    const members = ahead.getByTestId("dashboard-candidate");
    const memberCount = await members.count();
    for (let index = 0; index < memberCount; index += 1) {
      expect(
        await members.nth(index).locator("[data-kind-glyph]").count()
      ).toBe(1);
    }
  }
  // And the boundary the glyphs exist to draw: a reading LINE never earns one.
  expect(
    await main
      .locator('[data-testid="dashboard-candidate"][data-lane="standing"]')
      .locator("[data-kind-glyph]")
      .count()
  ).toBe(0);
});

test("Standing draws its aligned sparkline column on the desktop", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DAILY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const standing = page.getByTestId("dashboard-standing");
    const weight = standing.locator('[data-standing-family="weight"]');
    const spark = weight.getByTestId("standing-sparkline");
    await expect(spark).toBeVisible();
    await expect(spark).toHaveAttribute("data-sparkline-state", "series");
    // The endpoint is always drawn, and the hover names an exact value and date.
    await expect(
      spark.getByTestId("standing-sparkline-endpoint")
    ).toBeAttached();
    const titles = await spark
      .locator("[data-testid='standing-sparkline-point'] title")
      .allTextContents();
    expect(titles.length).toBeGreaterThan(1);
    // "63.6 kg · Friday, August 21" — a value with its unit, then the day in the
    // login's own date format. The exact value is the fixture's business, not this
    // assertion's; what is pinned is that BOTH facts are named.
    expect(titles[titles.length - 1]).toMatch(/^[\d.,]+ \S+ · .*\d+$/);

    // ONE COLUMN: every family that draws a plot draws it at the same right edge.
    const rights = await standing
      .getByTestId("standing-sparkline")
      .evaluateAll((nodes) =>
        nodes.map((node) => Math.round(node.getBoundingClientRect().right))
      );
    expect(rights.length).toBeGreaterThan(1);
    expect(new Set(rights).size).toBe(1);

    // AND THAT COLUMN IS THE TRAILING ONE (#3459). The shared-edge check above
    // cannot tell "aligned in the column" from "aligned in the wrong place": when
    // the three-column template lost the cascade to `sm:`, EVERY plot auto-flowed
    // onto a second grid row and they all shared one right edge down there — so
    // that assertion passed against precisely the bug it existed to catch. The
    // ruling is about POSITION, so position is what this pins: the plot sits to
    // the right of the facts it belongs to, on the same row as them.
    const column = await weight.evaluate((row) => {
      const facts = row.querySelector("dd")!.getBoundingClientRect();
      const plot = row
        .querySelector("[data-testid='standing-sparkline']")!
        .getBoundingClientRect();
      return {
        plotLeft: plot.left,
        plotTop: plot.top,
        plotBottom: plot.bottom,
        factsRight: facts.right,
        factsTop: facts.top,
        factsBottom: facts.bottom,
      };
    });
    expect(
      column.plotLeft,
      `the plot starts at ${column.plotLeft}, the facts cell ends at ${column.factsRight}`
    ).toBeGreaterThanOrEqual(column.factsRight);
    expect(column.plotTop).toBeLessThan(column.factsBottom);
    expect(column.plotBottom).toBeGreaterThan(column.factsTop);

    // DESKTOP DENSITY, NOT THE PHONE FLOOR (#3896). `button-control` renders at the
    // 44px tap floor and sheds it from sm upward, but the summary carried
    // `min-h-11! min-w-11!` — important declarations outrank that reset at EVERY
    // width, so all 18 consumers stayed pinned at 44px on the desktop. 1280px is well
    // above sm, so the compact row height is what must render here.
    const summary = weight
      .getByTestId("standing-sparkline-details")
      .locator("summary");
    await expect(summary).toBeVisible();
    const summaryHeight = await summary.evaluate(
      (node) => node.getBoundingClientRect().height
    );
    expect(summaryHeight).toBeLessThan(44);
    expect(summaryHeight).toBeGreaterThanOrEqual(20);

    // A family whose domain has no trend read draws nothing — that is the rule, and
    // the column still holds its place for the families that do.
    expect(
      await standing
        .locator('[data-standing-family="protein-today"]')
        .getByTestId("standing-sparkline")
        .count()
    ).toBe(0);
  } finally {
    await page.context().close();
  }
});

test("the sleep rows carry the profile's usual band as their hover sentence", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DAILY,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    const bed = page.locator(
      '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.bed-time:"]'
    );
    if ((await bed.count()) === 0) return; // the classifier declines below its gate
    const bedLink = bed.getByRole("link").first(); // first-ok: the E2E_LOGIN_DAILY fixture's sleep.bed-time row, one link
    const title = await bedLink.getAttribute("title");
    // Either the band, or silence. Never a half-sentence, and never a derived number
    // the classifier did not produce.
    if (title != null) expect(title).toMatch(/^Usual .+ – .+$/);
  } finally {
    await page.context().close();
  }
});

test("a page that just loaded animates nothing (#3253's resume half)", async ({
  page,
}) => {
  // The witnessed-only rule's quiet side, and the only side reachable without
  // #3075's silent refresh: a first paint and a reload have no "before" the viewer
  // saw, so no element may claim it just moved.
  await page.goto("/");
  await expect(page.getByTestId("now-strip")).toBeVisible();
  expect(await page.locator("[data-motion]").count()).toBe(0);
  await page.reload();
  await expect(page.getByTestId("now-strip")).toBeVisible();
  expect(await page.locator("[data-motion]").count()).toBe(0);
  expect(await page.locator(".motion-promote").count()).toBe(0);
});
