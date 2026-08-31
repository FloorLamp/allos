import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { workerDbPath } from "./worker-env";
import { followLink, hydratedClick, settledClick } from "./helpers";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_HXEVERY,
  HXEVERY_SELF_PROFILE,
  HXEVERY_RO_PROFILE,
  HXEVERY_MEMBER_PROFILE,
  HXEVERY_SELF_DOSE,
  HXEVERY_RO_DOSE,
  HXEVERY_MEMBER_DOSE,
  HXEVERY_DAY,
  HXEVERY_RO_ONLY_DAY,
} from "./fixture-logins";

// `/history?view=everyone` — THE MERGED RECORD (#4009 item 3, #3958, #2106).
//
// WHAT THE OTHER TIERS ALREADY PROVE, so this spec does not: the DB tier proves the
// composition (`mergeMemberTimelines` over per-member gathers) and the per-member age
// gate — the security-relevant half, i.e. that the page cannot widen exposure beyond
// what each member's own pages show this login — and the action tier proves that a
// forged cross-profile correction is REFUSED
// (lib/__action_tests__/history-cross-profile-correction.actions.test.ts). Neither can
// see a rendered page.
//
// SO WHAT IS HERE IS THE RENDERED SURFACE, and it is three claims:
//   1. Per-row SUBJECT attribution — whose row is whose, on a page that merges them.
//   2. The per-row WRITE GATE (#4009 item 1) — the ⋯ appears on the member this login
//      may write and not on the one it may not, asserted as the DIFFERENCE between two
//      rows in ONE render. An absence assertion alone cannot tell "the gate works"
//      from "the menu stopped rendering", which is why the fixture's two grants differ.
//   3. The CAPABILITY — a correction driven on ANOTHER member's row, which is the whole
//      point of item 1 and what a correction on the acting profile's own row cannot
//      show. It ran on the acting profile's dose until the #4067 review: the row was
//      the caller's, so a page that had ignored the row's profile entirely would have
//      passed. It is MEMBER's row now.
//   4. The mode is DEEP-LINKED, not chipped — reached from the household page (#1463),
//      with nothing on /history's own filter row advertising it. #3958 rules that out
//      explicitly: the sidebar is the app's one profile switcher, and a second
//      selection vocabulary is the parallel concept CLAUDE.md forbids.
//
// FIXTURE (#868 hygiene): spec-owned. E2E_LOGIN_HXEVERY holds SELF (write, acting), RO
// (read) and MEMBER (write) — see e2e/logins/household.ts for why the render test and
// the correction test want different pairs, and why MEMBER is never in the render
// test's view. Each carries one taken dose on a fixed past day. The correction is a
// persistent write, so the logs are reset before each test rather than assumed fresh —
// a retry must find the same tree the first run did.

// #4394's case. Long enough that it cannot fit the subject's ceiling at any phone
// width — measured at 320px it is 421px of text in a 147px box — so the row genuinely
// reaches the state the assertions forbid instead of passing because everything fitted.
const LONG_MEMBER_NAME =
  "Record Read Only Household Member With A Very Long Display Name 2 (e2e)";

// The narrowest CSS viewport a phone still reports, and the width #4394 was measured
// at: where the row has the least room and a cell that cannot give way shows.
const SMALLEST_PHONE_PX = 320;

function resetFixture(): { selfId: number; roId: number; memberId: number } {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  try {
    // THE NAMES ARE FIXTURE STATE, SO THE RESET OWNS THEM (#4394). The subject-ceiling
    // test renames a member to a pathological length, and its `finally` is not a
    // guarantee: a worker killed between the write and the restore would leave the next
    // test reading a name nothing puts back. Which is why the ids are resolved through
    // each member's dose ITEM and not through the profile NAME — a name-keyed lookup
    // cannot recover from the one hazard it exists to undo, because after a rename
    // there is nothing left to look up. No test renames an item.
    const idOf = (item: string) =>
      (
        db
          .prepare("SELECT profile_id AS id FROM intake_items WHERE name = ?")
          .get(item) as { id: number }
      ).id;
    const selfId = idOf(HXEVERY_SELF_DOSE);
    const roId = idOf(HXEVERY_RO_DOSE);
    const memberId = idOf(HXEVERY_MEMBER_DOSE);
    const rename = db.prepare("UPDATE profiles SET name = ? WHERE id = ?");
    rename.run(HXEVERY_SELF_PROFILE, selfId);
    rename.run(HXEVERY_RO_PROFILE, roId);
    rename.run(HXEVERY_MEMBER_PROFILE, memberId);
    // Put every member's log back to exactly one `taken` row on the fixture day: the
    // correction test deletes one, and a re-run has to start where the first did.
    for (const [pid, item] of [
      [selfId, HXEVERY_SELF_DOSE],
      [roId, HXEVERY_RO_DOSE],
      [memberId, HXEVERY_MEMBER_DOSE],
    ] as const) {
      const row = db
        .prepare(
          `SELECT i.id AS itemId, d.id AS doseId
             FROM intake_items i
             JOIN intake_item_doses d ON d.item_id = i.id
            WHERE i.profile_id = ? AND i.name = ?`
        )
        .get(pid, item) as { itemId: number; doseId: number };
      db.prepare("DELETE FROM intake_item_logs WHERE item_id = ?").run(
        row.itemId
      );
      db.prepare(
        `INSERT INTO intake_item_logs (item_id, dose_id, date, status)
         VALUES (?, ?, ?, 'taken')`
      ).run(row.itemId, row.doseId, HXEVERY_DAY);
    }
    const deleteSymptoms = db.prepare(
      "DELETE FROM symptom_logs WHERE profile_id = ?"
    );
    for (const pid of [selfId, roId, memberId]) deleteSymptoms.run(pid);
    const insertSymptom = db.prepare(
      `INSERT INTO symptom_logs (profile_id, date, symptom, severity)
       VALUES (?, ?, ?, ?)`
    );
    insertSymptom.run(selfId, HXEVERY_DAY, "headache", 2);
    insertSymptom.run(roId, HXEVERY_DAY, "nausea", 3);
    // RO ALONE, ON A DAY SELF HAS NOTHING ON (#4393 ruling 3). Everything else in
    // this fixture sits on the day BOTH members share, and a shared day is marked
    // whether the calendar unions the view-set or reads the acting profile only —
    // it would pass either way. This row is the only one the marks guard can
    // actually fail on.
    insertSymptom.run(roId, HXEVERY_RO_ONLY_DAY, "nausea", 2);
    return { selfId, roId, memberId };
  } finally {
    db.close();
  }
}

// The view-set is PERSISTED session state, and `?view=everyone` only merges when more
// than one profile is in it (`viewIds.length > 1`). The switcher panel's eye toggle is
// the one control that owns view membership — the same door multi-view.spec.ts drives.
// Past the pre-hydration disable gate (#830): the identity bar renders disabled until
// mounted, so wait for enabled before clicking or the tap is silently swallowed.
async function addToView(
  page: import("@playwright/test").Page,
  profileId: number
): Promise<void> {
  const trigger = page.getByTestId("profile-identity-bar");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByTestId("profile-switcher-panel")).toBeVisible();
  await settledClick(page, page.getByTestId(`view-toggle-${profileId}`));
}

test.describe("the record's merged household view (#4009 item 3)", () => {
  test("attributes every row and gates the ⋯ on the row's own profile", async ({
    browser,
  }) => {
    // Local `next dev` compiles /history and /household on first hit.
    test.slow();
    const { roId } = resetFixture();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_HXEVERY,
      password: E2E_MEMBER_PASSWORD,
    });

    // Acting profile is SELF — the lowest-id grant.
    await expect(page.getByTestId("profile-identity-bar")).toContainText(
      HXEVERY_SELF_PROFILE
    );

    // ── SINGLE VIEW FIRST, because it is the control ─────────────────────────
    // Everything below has to be attributable to the MODE rather than to the
    // fixture, and the only way to say that is to show the same page without it:
    // one member's row, no subject chip, and the other member's dose absent.
    //
    // ON `?kind=dose`, NOT ON THE UNFILTERED RECORD, and the reason is this issue's
    // own contract: filtered to a kind the page is the plain record, while in
    // Everything the dose rows collapse into a rollup line. Every claim in this spec
    // is about a ROW — its subject, its ⋯, the correction it dispatches — so the view
    // it is asserted on has to be one that draws rows.
    //
    // AND THE ROW IS THE SCOPE, not the page. Read page-wide, `getByText(SELF_DOSE)`
    // is satisfied by a NEIGHBOUR: the record also carries an insight row whose detail
    // segment names the same item ("1 dose · Record Self Vitamin"), so that assertion
    // passed on the unfiltered view even with the dose row collapsed out of the DOM —
    // green, and no longer about the dose row at all.
    await page.goto("/history?kind=dose");
    await expect(
      page.getByTestId("history-row").filter({ hasText: HXEVERY_SELF_DOSE })
    ).toHaveCount(1);
    await expect(
      page.getByTestId("history-row").filter({ hasText: HXEVERY_RO_DOSE })
    ).toHaveCount(0);
    await expect(page.getByTestId("history-row-subject")).toHaveCount(0);

    // ── THE MODE IS NOT ON THE FILTER ROW ────────────────────────────────────
    // #3958: no view switcher on this page, at any width. Scoped to the filter row
    // rather than to the page, because "everyone" is a word the sidebar and the nav
    // may legitimately use — a page-wide text search would pass or fail on a
    // neighbour's copy rather than on this claim.
    await expect(
      page.getByTestId("history-filters").getByText(/every(one|body)/i)
    ).toHaveCount(0);

    // ── THE DOOR IS THE HOUSEHOLD PAGE (#1463) ───────────────────────────────
    // Followed rather than typed. `?view=everyone` shipped with no door at all in
    // phase 1, which is the state this asserts is over: a capability reachable only
    // by hand-typing a query string is not demoted, it is retired.
    await page.goto("/household");
    await followLink(
      page,
      page.getByTestId("household-record-link"),
      /\/history\?view=everyone/
    );

    // The view-set is still one profile, so the mode has nothing to merge yet — and
    // that degrade is the honest one: the page renders, it just renders single view.
    await expect(page.getByTestId("history-page")).toBeVisible();

    // ── MERGED ───────────────────────────────────────────────────────────────
    await addToView(page, roId);

    // THE ROLLUP LINE CARRIES THE ATTRIBUTION TOO, and in Everything it is the only
    // thing that does for a log kind — so it is asserted here rather than left to the
    // pure tier. PER MEMBER is the load-bearing half of the rollup rule ("a mixed
    // count would hide whose logs they were"): two members' doses on one day must be
    // TWO lines each naming its own subject, never one line counting both.
    await page.goto("/history?view=everyone");
    // SCOPED TO THE DAY THE CLAIM IS ABOUT — "two members' doses ON ONE DAY must be
    // two lines". Read page-wide it was also a claim about how many DAYS each member
    // has anything on, which is the fixture's business and not this rule's: the marks
    // guard below needs a day RO has and SELF does not, and that row alone moved the
    // page-wide count to 2 while the per-day rule it stands for never changed.
    const rollups = page
      .locator(`#timeline-day-${HXEVERY_DAY}`)
      .getByTestId("history-rollup");
    await expect(rollups.filter({ hasText: HXEVERY_SELF_PROFILE })).toHaveCount(
      1
    );
    await expect(rollups.filter({ hasText: HXEVERY_RO_PROFILE })).toHaveCount(
      1
    );

    // ── THE ROWS THEMSELVES, on the view that draws them ──────────────────────
    // BOTH members' doses, on one page, each naming its subject. Scoped to the row and
    // counted rather than matched as page text: the two fixture item names share the
    // prefix "Record", so a substring read would be satisfied by either row alone —
    // and, as above, by an insight row that merely mentions the item.
    await page.goto("/history?kind=dose&view=everyone");
    const selfDoseRow = page
      .getByTestId("history-row")
      .filter({ hasText: HXEVERY_SELF_DOSE });
    const roDoseRow = page
      .getByTestId("history-row")
      .filter({ hasText: HXEVERY_RO_DOSE });
    await expect(selfDoseRow).toHaveCount(1);
    await expect(roDoseRow).toHaveCount(1);
    await expect(selfDoseRow.getByTestId("history-row-subject")).toHaveText(
      HXEVERY_SELF_PROFILE
    );
    await expect(roDoseRow.getByTestId("history-row-subject")).toHaveText(
      HXEVERY_RO_PROFILE
    );

    // ── THE PER-ROW WRITE GATE (#4009 item 1 / #2106) ────────────────────────
    // The claim is a RELATIONSHIP between the two rows, so it is asserted as one:
    // the writable member's row has the menu, the read-only member's does not, in
    // the same render. Either half alone is satisfiable by a page that draws no
    // menus at all, which is exactly the phase-1 behaviour this replaces.
    await expect(selfDoseRow.getByTestId("overflow-menu-trigger")).toHaveCount(
      1
    );
    await expect(roDoseRow.getByTestId("overflow-menu-trigger")).toHaveCount(0);

    // The same merged view narrowed to Symptoms contains both members' symptom rows
    // and no dose neighbour. This is the exact deep link whose earlier unscoped menu
    // probe mistook for an ignored filter (#4237).
    await page.goto("/history?kind=symptom&view=everyone");
    // ON THE FIXTURE DAY, for the same reason the rollup counts above are: "one row
    // per member, each naming its own subject" is a per-day claim, and RO also owns
    // the neighbouring day the marks guard below needs.
    const symptomRows = page
      .locator(`#timeline-day-${HXEVERY_DAY}`)
      .locator('[data-testid="history-row"][data-history-kind="symptom"]');
    await expect(symptomRows).toHaveCount(2);
    await expect(
      symptomRows
        .filter({ hasText: "Headache" })
        .getByTestId("history-row-subject")
    ).toHaveText(HXEVERY_SELF_PROFILE);
    await expect(
      symptomRows
        .filter({ hasText: "Nausea" })
        .getByTestId("history-row-subject")
    ).toHaveText(HXEVERY_RO_PROFILE);
    await expect(
      page.locator('[data-testid="history-row"][data-history-kind="dose"]')
    ).toHaveCount(0);
  });

  test("a correction on a writable member's row lands on that member", async ({
    browser,
  }) => {
    test.slow();
    const { selfId, roId, memberId } = resetFixture();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_HXEVERY,
      password: E2E_MEMBER_PASSWORD,
    });
    // MEMBER alone goes into the view — the acting profile is always in it, and RO
    // stays OUT deliberately: its row is not needed on screen for the delete, and its
    // stored count below is then a negative control on a profile the page never even
    // rendered.
    await addToView(page, memberId);
    // FILTERED TO THE KIND, for the same reason the case above is: a correction is
    // driven from a row's ⋯, and in Everything a dose row is inside a rollup rather
    // than on the page. The gate being proven is per-ROW and has nothing to do with
    // which view drew the row.
    await page.goto("/history?kind=dose&view=everyone");

    // Delete MEMBER's dose — a writable profile that is NOT the acting one, which is
    // the capability #4009 item 1 grants and the one thing no other tier can reach:
    // the DB tier cannot render a page and the action tier posts its own FormData.
    // Everything from the ⋯ down here is a real browser deciding what to send.
    const memberRow = page
      .getByTestId("history-row")
      .filter({ hasText: HXEVERY_MEMBER_DOSE });
    await hydratedClick(page, memberRow.getByTestId("overflow-menu-trigger"));
    // The menu item opens the shared confirm dialog — a client toggle, no POST — and
    // the dialog's own Delete is what dispatches the Server Action.
    await page.getByTestId("history-row-delete").click();
    await settledClick(
      page,
      page.getByTestId("confirm-dialog").getByRole("button", { name: "Delete" })
    );

    // SCOPED TO THE ROW, never to the page: the record carries insight rows whose
    // detail segment names the same item, so a page-wide text read answers about a
    // neighbour rather than about the row the correction was driven from.
    await expect(
      page.getByTestId("history-row").filter({ hasText: HXEVERY_MEMBER_DOSE })
    ).toHaveCount(0);
    // The ACTING profile's row survives, and it is the one that has to be named: a
    // correction that fell back to the session — the exact defect the gate exists to
    // prevent — lands there, and "the row I clicked went away" cannot see it.
    await expect(
      page.getByTestId("history-row").filter({ hasText: HXEVERY_SELF_DOSE })
    ).toHaveCount(1);

    // And in the store, per profile rather than per row count.
    const db = new Database(workerDbPath());
    db.pragma("busy_timeout = 5000");
    try {
      const takenFor = (pid: number) =>
        (
          db
            .prepare(
              `SELECT COUNT(*) AS n FROM intake_item_logs l
                 JOIN intake_items i ON i.id = l.item_id
                WHERE i.profile_id = ? AND l.status = 'taken'`
            )
            .get(pid) as { n: number }
        ).n;
      expect(takenFor(memberId)).toBe(0);
      expect(takenFor(selfId)).toBe(1);
      // Never in view, never rendered, and still there.
      expect(takenFor(roId)).toBe(1);
    } finally {
      db.close();
    }
  });

  // THE CALENDAR MARKS THE VIEW-SET, NOT THE ACTING PROFILE (#4393 ruling 3).
  //
  // The grid moved off the nav and onto this page in #4280 carrying the nav's
  // answer to "whose days are these" — the acting profile's — which reads wrong
  // beside a merged feed. The ruling is that it answers the same question the feed
  // it navigates answers, so this asserts the marks as a DIFFERENCE between the two
  // modes rather than as a count: the SAME day, the SAME locator, marked in
  // Everyone and unmarked in single view. Either half alone is satisfiable by a
  // grid that marks everything, or nothing.
  //
  // THE DAY IS RO's ALONE. Every other row in this fixture sits on HXEVERY_DAY,
  // which both members have — a union and an acting-profile read mark it
  // identically, so a guard written on it passes against the defect it names.
  test("the month grid marks the whole view-set under ?view=everyone", async ({
    browser,
  }) => {
    test.slow();
    const { roId } = resetFixture();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_HXEVERY,
      password: E2E_MEMBER_PASSWORD,
    });
    await addToView(page, roId);

    const panel = page.getByTestId("history-calendar-panel");
    // ONE locator shape for the claim and for its control, so the control cannot
    // pass through a query the assertion never runs: a marked day is an anchor,
    // an unmarked one is an inert div, and this asks the grid for the anchor.
    const markedDay = (label: string) =>
      panel.locator(`a[data-calendar-day][aria-label="${label}"]`);
    // The grid opens on today and runs from its earliest destination; the fixture
    // day is a fixed month in the past, so the month is chosen through the grid's
    // own selects rather than by counting Previous-month taps off the run date.
    const openOnFixtureMonth = async () => {
      await hydratedClick(page, page.getByTestId("history-calendar"));
      await expect(panel).toBeVisible();
      // `exact`, because "Previous month" and "Next month" are labels too.
      await panel.getByLabel("Year", { exact: true }).selectOption("2026");
      await panel
        .getByLabel("Month", { exact: true })
        .selectOption({ label: "Jun" });
      await expect(markedDay("June 11, 2026")).toHaveCount(1);
    };

    // SINGLE VIEW IS THE CONTROL, and its own positive control is the shared day:
    // the locator finds a mark here, so the zero below is the mode's answer and
    // not a selector that never matches.
    await page.goto("/history");
    await openOnFixtureMonth();
    await expect(markedDay("June 12, 2026")).toHaveCount(0);

    // MERGED: RO's day is now a door, and it opens INSIDE the view it was marked
    // from — every other href on this page carries the mode, and a door that
    // dropped it would open a household day on the acting profile alone.
    await page.goto("/history?view=everyone");
    await openOnFixtureMonth();
    await expect(markedDay("June 12, 2026")).toHaveCount(1);
    await expect(markedDay("June 12, 2026")).toHaveAttribute(
      "href",
      "/history?day=2026-06-12&view=everyone"
    );
  });

  // #4394. THE CELL THAT NEVER YIELDS IS THE CELL THAT NEEDS A CEILING.
  //
  // The subject is `shrink-0` on purpose — it says WHOSE line this is, and an
  // ellipsized subject is unreadable in a way a truncated title is not — so it takes no
  // part in the line's shrink negotiation. That cannot be expressed as a shrink factor:
  // below 1 a factor caps the whole line's shrink instead of deprioritising the item,
  // and 0 means never, with nothing in between. So the subject carries a max-width, and
  // this is what that bound is FOR.
  //
  // BOTH MOUNTS, because the merged record draws the subject twice: on a ROW (any kind
  // filter) and on the ROLLUP LINE (Everything, where a log kind collapses to a count).
  // Measured at 320px with the ceiling removed, the rollup's label goes to 0px painted
  // exactly as the row's title does, so the second mount is not decoration.
  //
  // MEASURED IN PAINTED PIXELS, NOT BOUNDING BOXES, and that distinction is the whole
  // test. `expectNoClippedContent` walks `getBoundingClientRect` and never intersects a
  // box with the ancestors that clip it, so it PASSED the tree this case was written
  // against — a line whose title had been squeezed to zero width and rendered with no
  // name at all, while the box arithmetic looked fine. A future reader will find this
  // redundant with the no-clip sweep. It is not: the sweep cannot see this defect.
  //
  // BOUNDS, NOT VALUES: that the title keeps SOMETHING and that the subject SAYS it was
  // cut. Pinning "the title is 65.6px" would pin the font.
  test("a long member name never costs a line its own title", async ({
    browser,
  }) => {
    test.slow();
    const { roId } = resetFixture();
    const db = new Database(workerDbPath());
    db.pragma("busy_timeout = 5000");
    db.prepare("UPDATE profiles SET name = ? WHERE id = ?").run(
      LONG_MEMBER_NAME,
      roId
    );
    db.close();
    try {
      const page = await loginAs(browser, {
        username: E2E_LOGIN_HXEVERY,
        password: E2E_MEMBER_PASSWORD,
      });
      await addToView(page, roId);
      await page.setViewportSize({ width: SMALLEST_PHONE_PX, height: 844 });

      for (const view of [
        "/history?kind=dose&view=everyone",
        "/history?view=everyone",
      ]) {
        await page.goto(view);
        await expect(
          page.getByTestId("history-row-subject").first() // first-ok: waited on so the read below is not of an empty list
        ).toBeVisible();

        const lines = await page.evaluate(() => {
          const vw = document.documentElement.clientWidth;
          // WHAT A READER SEES: the box, intersected with the viewport AND with every
          // ancestor that clips horizontally. The nearest one is the line's own
          // truncating cluster, 163–211px wide at this viewport, so a viewport-only
          // reading reports content as visible that was painted over.
          const painted = (el: Element): number => {
            const r = el.getBoundingClientRect();
            let lo = r.left;
            let hi = r.right;
            for (let a = el.parentElement; a; a = a.parentElement) {
              const o = getComputedStyle(a).overflowX;
              if (o === "hidden" || o === "clip") {
                const ar = a.getBoundingClientRect();
                lo = Math.max(lo, ar.left);
                hi = Math.min(hi, ar.right);
              }
            }
            return Math.max(0, Math.min(hi, vw) - Math.max(lo, 0));
          };
          // THE TITLE IS THE SUBJECT'S PRECEDING SIBLING at both mounts — the row's
          // title element and the rollup's label span — which is the one way to name
          // it that does not couple this test to either mount's markup.
          return Array.from(
            document.querySelectorAll<HTMLElement>(
              '[data-testid="history-row-subject"]'
            )
          ).map((subject) => {
            const title = subject.previousElementSibling;
            return {
              subjectText: (subject.textContent ?? "").trim(),
              titlePainted: title ? painted(title) : null,
              subjectPainted: painted(subject),
              subjectBox: subject.getBoundingClientRect().width,
              subjectNatural: subject.scrollWidth,
              subjectEllipsized: subject.scrollWidth > subject.clientWidth + 1,
            };
          });
        });

        const long = lines.find((l) => l.subjectText === LONG_MEMBER_NAME);
        const ordinary = lines.find(
          (l) => l.subjectText === HXEVERY_SELF_PROFILE
        );
        expect(
          { long: !!long, ordinary: !!ordinary },
          `${view}: both the long-named member's line and the acting profile's must render`
        ).toEqual({ long: true, ordinary: true });

        // THE FIXTURE REACHES THE STATE. A name that fits under the ceiling would
        // satisfy every assertion below while proving none of them.
        expect(
          long!.subjectNatural,
          `${view}: the seeded name is ${long!.subjectNatural}px of text in a ${Math.round(
            long!.subjectBox
          )}px box — it must not fit, or this proves nothing`
        ).toBeGreaterThan(long!.subjectBox);

        // THE CLAIM, as a relationship and not a pixel count: every line keeps its own
        // name, and a subject that was cut says so.
        expect(
          lines.filter((l) => !l.titlePainted).map((l) => l.subjectText),
          `${view}: a subject squeezed these lines' titles to nothing`
        ).toEqual([]);
        expect(
          long!.subjectEllipsized,
          `${view}: the subject was cut without saying so`
        ).toBe(true);

        // AND THE ORDINARY LINE DOES NOT PAY FOR IT. Its subject fits the ceiling, so
        // it must be painted whole — this is BROKEN ON MAIN, where the row's cluster
        // paints 33px of a 94px subject inside a viewport it fits comfortably.
        expect(
          ordinary!.subjectPainted,
          `${view}: an ordinary member name is painted ${Math.round(
            ordinary!.subjectPainted
          )}px of ${Math.round(ordinary!.subjectBox)}px`
        ).toBeGreaterThanOrEqual(ordinary!.subjectBox - 1);
        expect(
          ordinary!.subjectEllipsized,
          `${view}: an ordinary member name should not be ellipsized at all`
        ).toBe(false);
      }
    } finally {
      // resetFixture owns this too, and would put it back for the next test in this
      // file. The prompt restore is for the OTHER spec files that share this worker's
      // database, which never call resetFixture at all.
      const restore = new Database(workerDbPath());
      restore.pragma("busy_timeout = 5000");
      restore
        .prepare("UPDATE profiles SET name = ? WHERE id = ?")
        .run(HXEVERY_RO_PROFILE, roId);
      restore.close();
    }
  });
});
