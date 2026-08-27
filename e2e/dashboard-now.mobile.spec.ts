import { test, expect } from "./fixtures";
import { type Browser, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { expectNoClippedContent, settledBoxes } from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_DAILY,
  E2E_LOGIN_SICK_SELF,
  E2E_LOGIN_NOWSTRIP,
  E2E_LOGIN_NOWSAFETY,
  E2E_LOGIN_NOWQUIET,
  E2E_LOGIN_WHATSNEW,
  NOW_QUIET_TARGETS,
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
      const cards = strip.locator("[data-testid^='now-strip-card-']");
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
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_WHATSNEW,
  });
  try {
    const strip = page.getByTestId("now-strip");
    await expect(strip).toHaveAttribute("data-count", "0");
    await expect(strip.getByTestId("now-strip-empty")).toHaveText(
      "Nothing needs you."
    );
    await expect(strip.getByTestId("now-strip-date")).toBeVisible();
    await expect(strip.locator("[data-testid^='now-strip-card-']")).toHaveCount(
      0
    );
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
    const safety = page.locator(
      "[data-testid^='now-strip-card-attention.fact:mental-health:crisis']"
    );
    await expect(safety).toHaveCount(1);
    const fact = safety.getByTestId("dashboard-candidate");
    await expect(fact.getByTestId("dashboard-attention-atom")).toBeVisible();
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
  const page = await openDashboard(browser, { username: E2E_LOGIN_WHATSNEW });
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

test("the attention atom flows on one line inside one gutter on a phone, and keeps its stacked block and hover inset above `sm`", async ({
  page,
}) => {
  for (const viewport of ATOM_VIEWPORTS) {
    await page.setViewportSize(viewport.size);
    await page.goto("/");
    const card = page
      .locator("[data-testid^='now-strip-card-']")
      .filter({ has: page.getByTestId("attention-item-detail") })
      .first(); // first-ok: every ordinary Now card is laid out by the same atom
    await expect(card).toBeVisible();
    // Wait for the DETAIL, not the card: the thing being measured is the flow
    // between two elements, and a card that has only painted its title would let
    // this pass by measuring nothing.
    const detail = card.getByTestId("attention-item-detail").first(); // first-ok: the card above is one atom
    await expect(detail).toBeVisible();

    const geometry = await card.evaluate((node) => {
      const strip = document
        .querySelector('[data-testid="now-strip"]')!
        .getBoundingClientRect();
      const atomNode = node.querySelector<HTMLElement>(
        '[data-testid="dashboard-attention-atom"]'
      )!;
      const atom = atomNode.getBoundingClientRect();
      const atomStyle = getComputedStyle(atomNode);
      const rowNode = node.querySelector<HTMLElement>(
        '[data-testid^="attention-item-"]'
      )!;
      const rowStyle = getComputedStyle(rowNode);
      const icon = rowNode.querySelector("svg")!.getBoundingClientRect();
      const title = node
        .querySelector('[data-testid="dashboard-attention-atom"] a')!
        .getBoundingClientRect();
      const detail = node
        .querySelector('[data-testid="attention-item-detail"]')!
        .getBoundingClientRect();
      const separator = node.querySelector<HTMLElement>(
        '[data-testid="dashboard-attention-atom"] span[aria-hidden="true"]'
      );
      const glyph = node.querySelector<HTMLElement>("[data-kind-glyph]");
      return {
        stripLeft: strip.left,
        stripWidth: strip.width,
        atomLeft: atom.left,
        atomWidth: atom.width,
        // The card's OWN gutter, from the card itself — the only inset the phone
        // ruling leaves standing.
        cardGutter:
          parseFloat(atomStyle.borderLeftWidth) +
          parseFloat(atomStyle.paddingLeft),
        // How far the row's first mark sits from the STRIP's edge. Independent of
        // anything inside the card: a glyph gutter outside the card and a row
        // inset inside it both show up here, and only here.
        firstMarkInset: icon.left - strip.left,
        rowPaddingLeft: rowStyle.paddingLeft,
        rowPaddingTop: rowStyle.paddingTop,
        titleTop: title.top,
        titleLeft: title.left,
        titleRight: title.right,
        titleBottom: title.bottom,
        detailTop: detail.top,
        detailLeft: detail.left,
        separatorDisplay: separator
          ? getComputedStyle(separator).display
          : null,
        glyphDisplay: glyph ? getComputedStyle(glyph).display : null,
      };
    });

    if (viewport.oneLine) {
      // ONE LINE: the detail sits BESIDE the title, sharing its line.
      expect(
        geometry.detailLeft,
        `detail starts at ${geometry.detailLeft}, title ends at ${geometry.titleRight}`
      ).toBeGreaterThan(geometry.titleRight);
      expect(Math.abs(geometry.detailTop - geometry.titleTop)).toBeLessThan(8);
      expect(geometry.separatorDisplay).not.toBe("none");

      // ONE GUTTER, measured from OUTSIDE the card so it can see both ways it
      // could be doubled: the card's own padding is the whole distance from the
      // strip's edge to the row's first mark. A glyph gutter beside the card adds
      // to this; the row's `px-2` inset adds to it too.
      expect(
        geometry.firstMarkInset,
        `first mark sits ${geometry.firstMarkInset}px from the strip edge, card gutter is ${geometry.cardGutter}px`
      ).toBeCloseTo(geometry.cardGutter, 1);
      expect({
        left: geometry.rowPaddingLeft,
        top: geometry.rowPaddingTop,
      }).toEqual({ left: "0px", top: "0px" });

      // And the CARD takes the width back — the atom itself, not the wrapper that
      // contains the gutter and would match the strip whatever is inside it.
      expect(geometry.atomLeft).toBeCloseTo(geometry.stripLeft, 1);
      expect(geometry.atomWidth).toBeCloseTo(geometry.stripWidth, 1);
      expect(geometry.glyphDisplay).toBe("none");
    } else {
      // ABOVE `sm` NOTHING MOVED. The desktop block stays stacked, the separator
      // is a phone mark only, the row keeps the inset its hover fill needs, and
      // the gutter glyph still rides beside the card.
      expect(
        geometry.detailTop,
        `detail top ${geometry.detailTop} vs title bottom ${geometry.titleBottom}`
      ).toBeGreaterThanOrEqual(geometry.titleBottom - 1);
      expect(Math.abs(geometry.detailLeft - geometry.titleLeft)).toBeLessThan(
        1
      );
      expect(geometry.separatorDisplay).toBe("none");
      expect({
        left: geometry.rowPaddingLeft,
        top: geometry.rowPaddingTop,
      }).toEqual({ left: "8px", top: "8px" });
      expect(geometry.glyphDisplay).not.toBe("none");
    }
  }
});

test("the Now gutter glyph is not shown at 390px, and Ahead keeps its inline one", async ({
  page,
}) => {
  await page.goto("/");
  const cards = page.locator("[data-testid^='now-strip-card-']");
  await expect(cards.first()).toBeVisible(); // first-ok: presence of the strip's cards, asserted by count next
  expect(await cards.count()).toBeGreaterThan(0);
  const glyphs = await cards
    .locator("[data-kind-glyph]")
    .evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).display)
    );
  // The glyphs are still IN the markup — the ruling is about where they show, not
  // about deleting them — so an empty list here would be this test measuring
  // nothing rather than measuring the ruling.
  expect(glyphs.length).toBeGreaterThan(0);
  expect(new Set(glyphs)).toEqual(new Set(["none"]));

  // Ahead is untouched at every width: its glyph rides inline in the member row,
  // which is already the folded-in form.
  const ahead = page.getByTestId("dashboard-ahead");
  if ((await ahead.count()) > 0) {
    const inline = await ahead
      .locator("[data-kind-glyph]")
      .evaluateAll((nodes) =>
        nodes.map((node) => getComputedStyle(node).display)
      );
    expect(inline.length).toBeGreaterThan(0);
    expect(inline.every((display) => display !== "none")).toBe(true);
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
      document.querySelectorAll("[data-testid^='now-strip-card-']")
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

test("the strip's own chrome is tighter on a phone and unchanged on the desktop", async ({
  browser,
}) => {
  for (const [options, gap, margin] of [
    [PHONE, "8px", "16px"],
    [DESKTOP, "12px", "24px"],
  ] as const) {
    const page = await openDashboard(
      browser,
      { username: E2E_LOGIN_NOWSTRIP },
      options
    );
    try {
      const strip = page.getByTestId("now-strip");
      await expect(
        strip.locator("[data-testid^='now-strip-card-']").first() // first-ok: the grid's own gap, read off the cards' parent
      ).toBeVisible();
      const chrome = await strip.evaluate((section) => {
        const grid = section.querySelector(
          "[data-testid^='now-strip-card-']"
        )!.parentElement!;
        return {
          gap: getComputedStyle(grid).rowGap,
          margin: getComputedStyle(section).marginBottom,
        };
      });
      expect(chrome).toEqual({ gap, margin });
    } finally {
      await page.context().close();
    }
  }
});

test("the illness cockpit keeps every section at 390px, on the stepped-down seams", async ({
  browser,
}) => {
  for (const [options, seam, header] of [
    [PHONE, "12px", "8px"],
    [DESKTOP, "16px", "12px"],
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
      // ruled section boundary (IllnessCockpitBody's readings band, the stale
      // nudge, the PRN block and the footer), and a guard that read only
      // `cockpit-prn` would have left three of the four free to drift. Seams are
      // found by their own border rather than by testid, so a section that is
      // conditional — the stale nudge does not render for every episode — is
      // covered when it renders and cannot fail the guard when it does not.
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
        return {
          seams,
          headerMargin: getComputedStyle(body.querySelector("h3")!)
            .marginBottom,
        };
      });
      // The sweep must have found the seams it is about.
      expect(
        rhythm.seams.length,
        `seams found: ${JSON.stringify(rhythm.seams)}`
      ).toBeGreaterThanOrEqual(3);
      expect(
        rhythm.seams.map((entry) => entry.edge),
        JSON.stringify(rhythm.seams)
      ).toEqual(rhythm.seams.map(() => `${seam}/${seam}`));
      expect(rhythm.headerMargin).toBe(header);
      if (options === PHONE) await expectNoClippedContent(page);
    } finally {
      await page.context().close();
    }
  }
});
