import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { loginAs } from "./nav";
import { hydratedClick } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_SEARCH_RECORD,
  SEARCH_RECORD_PRACTICE,
  SEARCH_RECORD_PRACTICE_DAY,
  SEARCH_RECORD_FOOD_NAME,
  SEARCH_RECORD_FOOD_DAY,
  SEARCH_RECORD_SYMPTOM_NAME,
  SEARCH_RECORD_SYMPTOM_DAY,
} from "./fixture-logins";

// SEARCH FINDS THE ROWS YOU LOGGED, AND OPENS THE RECORD ON THAT ENTRY (#5006).
//
// The phone's cost for "my latest sauna" was three taps from Home, and Search — two
// taps away in the dock — could not shorten it, because it indexed every entity with
// a page and none of the rows people log. This drives the whole journey at the
// viewport the issue is about: dock → Search → type → pick → the record, scrolled to
// the row.
//
// WHICH GROUP THE HIT CAME FROM IS PART OF THE ASSERTION. A practice's session and
// the practice itself share a title on purpose, and only one of them opens the
// record — so every pick below is made inside `palette-group-logged`, never on a
// title alone. That one group holds all seven logged kinds (owner ruling,
// 2026-09-04); the kind is in the hit's subtitle.
//
// EVERY `getByTestId` HERE IS SCOPED TO A CONTAINER (the dock, the dialog, the feed).
// The app streams its Suspense boundaries: a boundary's content first lands in a
// `<div hidden>` on `<body>` and an inline `$RC` script relocates it, so during that
// window a testid inside one exists TWICE and a page-rooted lookup is a strict-mode
// violation. Scoping is the fix; a timeout or `.first()` would only hide it.
//
// Fixture (#868): a dedicated login over one dedicated profile (e2e/logins/search.ts)
// carrying exactly one practice session, one serving and one symptom, on deep-past
// days of their own. Every test READS — opening the palette and following a link
// writes nothing — so the file is repeat-safe.

/** The record's day-scoped address, as `historyHref` spells it (param order fixed). */
function dayHref(kind: string, day: string): string {
  return `/history?kind=${kind}&day=${day}`;
}

interface RecordCase {
  what: string;
  /** What a person types — the DISPLAY vocabulary, not the stored key. */
  query: string;
  kind: "practice" | "food" | "symptom";
  day: string;
  /** The subtitle the hit prints: the record's word for the row, and the day in the
   *  login's date shape — never the stored `YYYY-MM-DD` (#3492/#3545). */
  subtitle: string;
  title: string;
  /** The row id the record renders, as `timelineEntryAnchorId` spells it. */
  anchor: RegExp;
}

const CASES: RecordCase[] = [
  {
    what: "a practice session",
    query: SEARCH_RECORD_PRACTICE,
    kind: "practice",
    subtitle: "Practice · Jan 12",
    day: SEARCH_RECORD_PRACTICE_DAY,
    title: SEARCH_RECORD_PRACTICE,
    anchor: /^timeline-entry-practice-\d+$/,
  },
  {
    what: "a food group",
    query: SEARCH_RECORD_FOOD_NAME,
    kind: "food",
    subtitle: "Serving · Jan 13",
    day: SEARCH_RECORD_FOOD_DAY,
    title: SEARCH_RECORD_FOOD_NAME,
    anchor: /^timeline-entry-food-\d+$/,
  },
  {
    what: "a symptom",
    query: SEARCH_RECORD_SYMPTOM_NAME,
    kind: "symptom",
    subtitle: "Symptom · Jan 14",
    day: SEARCH_RECORD_SYMPTOM_DAY,
    title: SEARCH_RECORD_SYMPTOM_NAME,
    anchor: /^timeline-entry-symptom-2026-01-14-sore_throat$/,
  },
];

// The dock, reached by its landmark role rather than by a page-rooted testid, so the
// slots inside it are looked up within a container that exists exactly once.
function dock(page: Page): Locator {
  return page.getByRole("navigation", { name: "Primary" });
}

// Open the palette from the dock's Search slot. The slot is a pure client trigger
// (`openGlobalSearch()`), so the tap has to land past hydration or it is swallowed
// with no error (#500) — `hydratedClick` waits for the handler, then clicks once.
async function openSearchFromDock(page: Page): Promise<Locator> {
  const trigger = dock(page).getByTestId("dock-slot-search");
  await expect(trigger).toBeVisible();
  await hydratedClick(page, trigger);
  const palette = page.getByRole("dialog");
  await expect(palette).toBeVisible();
  return palette;
}

test.describe("search into the record (#5006)", () => {
  for (const record of CASES) {
    test(`finds ${record.what} and opens the record on that entry`, async ({
      browser,
    }) => {
      const page = await loginAs(browser, {
        username: E2E_LOGIN_SEARCH_RECORD,
        password: E2E_MEMBER_PASSWORD,
      });
      await page.goto("/");

      const palette = await openSearchFromDock(page);
      await palette
        .getByRole("combobox", { name: "Search or run a command" })
        .fill(record.query);

      // The LOGGED group, not the entity group that may share this title.
      const group = palette.getByTestId("palette-group-logged");
      const hit = group.getByRole("option", { name: record.title });
      await expect(hit).toBeVisible();
      // The subtitle says which KIND this is and which day the entry is on, so the
      // reader knows what they are about to open before they open it. Asserted whole
      // rather than on the date alone: "Jan 12" on its own could come from anywhere
      // on the row, and the pair cannot.
      await expect(hit).toContainText(record.subtitle);

      await hit.click();
      await page.waitForURL(
        (url) => url.pathname + url.search === dayHref(record.kind, record.day)
      );
      // The fragment is the row's own anchor — this is what makes the hit land on
      // the entry rather than on the day's list of them.
      const fragment = new URL(page.url()).hash.slice(1);
      expect(fragment).toMatch(record.anchor);

      // AND THE ROW IS ACTUALLY THERE, AND ACTUALLY IN VIEW. Waiting for the feed's
      // own row first: a viewport assertion against a region that has not rendered
      // its content yet is a claim about whatever happened to be there, and empty is
      // the state that flatters (#3384).
      const feed = page.getByRole("main").getByTestId("history-feed");
      const row = feed.locator(`#${fragment}`);
      await expect(row).toBeVisible();
      await expect(row).toContainText(record.title);
      await expect(row).toBeInViewport();
      await page.context().close();
    });
  }

  // THE ORDER IS THE RULING (2026-09-04): typing "sauna" shows your sessions before
  // the practice card. Both groups are on screen for this query — the catalog entity
  // is built from these very sessions — so this is a comparison between two real
  // elements, not an assertion that one of them renders.
  test("puts the rows you logged above the practice that names them", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SEARCH_RECORD,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/");

    const palette = await openSearchFromDock(page);
    await palette
      .getByRole("combobox", { name: "Search or run a command" })
      .fill(SEARCH_RECORD_PRACTICE);

    const logged = palette.getByTestId("palette-group-logged");
    const practice = palette.getByTestId("palette-group-practice");
    await expect(logged).toBeVisible();
    await expect(practice).toBeVisible();
    // Wait for the hit itself before measuring: a group whose rows have not landed
    // yet has a box, and it is not the box this test is about (#3384).
    await expect(
      logged.getByRole("option", { name: SEARCH_RECORD_PRACTICE })
    ).toBeVisible();

    const loggedBox = await logged.boundingBox();
    const practiceBox = await practice.boundingBox();
    expect(loggedBox).not.toBeNull();
    expect(practiceBox).not.toBeNull();
    expect(loggedBox!.y).toBeLessThan(practiceBox!.y);
    await page.context().close();
  });
});
