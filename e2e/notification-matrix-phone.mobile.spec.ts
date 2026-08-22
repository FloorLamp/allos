import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { expectNoClippedContent, settledBoxes } from "./helpers";
import { E2E_LOGIN_MATRIX_PHONE, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { CARD_MODE_BREAKPOINT_PX } from "../lib/card-row";

// THE MESSAGE-KINDS MATRIX AT PHONE WIDTH (issue #3495).
//
// WHAT WAS WRONG, and it is a geometry defect end to end. The kind × channel matrix
// gave its four channel columns a fixed `w-40` below `sm` — 160px for four columns,
// about 37px each once the `gap-1` is paid. "Telegram" cannot fit 37px, so the header
// label painted straight over its neighbour and read "TelegramPush"; the amber "not
// set up" state wrapped to three lines; and because each header stack then ended at a
// DIFFERENT height, the four sweep boxes came to rest on four different baselines,
// visually detached from the columns they sweep.
//
// SO THE ASSERTIONS ARE MEASUREMENTS, NOT CLASS LISTS (#3466's lesson, #3491's shape):
// every verdict below comes off `getBoundingClientRect()`. "Does this label's box stay
// inside its own chip", "do two labels' boxes overlap", "is the sweep box on the same
// line as the channel it sweeps" — none of those can be answered by a computed style,
// and this tree has already shipped a green declaration over a wrong render.
//
// AND THE PROBE PROVES IT CAN SEE. The last case FORGES the old arrangement at the
// same width and requires the same probe to call it collided. A "nothing overlaps"
// assertion passes on any layout that happens to fit, including one where the probe
// has gone blind.
//
// DESKTOP IS THE OTHER HALF OF THE CLAIM and it is asserted here too, at 1280×900 in
// the same file, because "unchanged" is the part worth proving rather than stating.
// Two independent proofs, deliberately of different kinds:
//   * STRUCTURAL — every rule the phone shape adds lives in `@utility
//     notification-kind-matrix` and is `max-sm:`-scoped, which
//     `lib/__tests__/card-mode-boundary.test.ts` enforces; a `max-sm:` variant emits
//     only inside `@media (width < 40rem)`, so at ≥`sm` it contributes nothing. The
//     chip wrapper is `display: contents` there, so it generates no box at all and the
//     checkbox stays the grid item it has always been.
//   * MEASURED — the desktop case below reads the rendered grid: four equal columns on
//     one baseline, each sweep box centred over its own column, chips not painted, and
//     the reserved-toggle slot NOT reserved (a safety kind's title still starts left of
//     a toggleable kind's, exactly as it did).
//
// Fixture ownership (#868): its own login and profile (`seedMatrixPhone`). The
// editability case WRITES a login-scoped routing preference, and on a shared login that
// write would silence a kind for every other spec's session.

const ROUTE = "/settings/notifications";

// Card mode is `width < CARD_MODE_BREAKPOINT_PX` (lib/card-row.ts). The `mobile`
// project's viewport is 390px, which is inside it; deriving the claim from the constant
// rather than typing 390 twice is what makes this spec move when the boundary moves
// (#3457/#3538).
const PHONE_WIDTH = 390;

// The desktop half. 1280×900 is the `chromium` project's own viewport, restated here
// because a `.mobile.spec.ts` runs only in the `mobile` project.
const DESKTOP = { width: 1280, height: 900 };

// The channel columns the page renders. RE-DERIVED rather than trusted: the issue says
// "four", and the four are declared in NotificationPrefs' `columns`. The probe counts
// what rendered and this is the floor it is held to.
const CHANNEL_IDS = ["telegram", "push", "ha", "email"] as const;

// Kinds the registry renders unconditionally — named subjects beside the count, because
// a count alone goes green the moment the probe stops finding rows. `dose` and
// `escalation` are the two SAFETY kinds (no master toggle, by design); `preventive` is
// a toggleable one, and the pair is what the alignment case compares.
const SAFETY_KIND = "dose";
const TOGGLEABLE_KIND = "preventive";
// Home Assistant is the one column whose liveness this spec can rely on: it is
// PROFILE-owned and this profile has no webhook, so the column is reliably NOT set up
// and its kept ticks render as ghosts. Telegram, Push and Email all turn on
// instance-wide config that neighbouring specs configure and reset mid-run — the same
// reason e2e/matrix-column-liveness.spec.ts owns only this column end to end.
const GHOST_CHANNEL = "ha";
const GHOST_KIND = "refill";

interface Chip {
  id: string;
  /** The chip's own box. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The channel-name text's box, and its vertical centre. */
  labelLeft: number;
  labelRight: number;
  labelCy: number;
  labelText: string;
  /** The control's box: a sweep checkbox in the header, a routing box in a row. */
  boxLeft: number;
  boxCx: number;
  boxCy: number;
  boxVisible: boolean;
}

interface Shape {
  /** The corpus floor. Zero of either means the probe read an empty page. */
  channelCount: number;
  kindCount: number;
  cardWidth: number;
  /** The per-channel summary row (the header strip). */
  head: Chip[];
  /** One kind's own channel chips. */
  row: Chip[];
  /** The bottom of that kind's title/description block, and the top of its chips. */
  rowTextBottom: number;
  rowChipsTop: number;
  /** Left edge of the title text on a safety kind and on a toggleable one. */
  safetyTitleLeft: number;
  toggleableTitleLeft: number;
  /** Rendered height and line-height of the two lines of meta copy above the list. */
  metaHeights: { height: number; lineHeight: number }[];
  /** How the sweep strip is painted, against how a kind's chip line is painted. */
  sweepPanel: {
    labelText: string;
    labelPainted: boolean;
    background: string;
    borderTopWidth: number;
  };
  rowPanel: { background: string; borderTopWidth: number };
}

/**
 * Read the whole surface's rendered shape in one pass. No class names and no computed
 * styles except `line-height`, which is the unit the "~3 lines of meta" acceptance
 * criterion is stated in and cannot be recovered from a box.
 */
async function readShape(
  page: Page,
  kind: string,
  channels: readonly string[]
): Promise<Shape> {
  return page.evaluate(
    ({ kind, channels }) => {
      const box = (el: Element | null) =>
        el?.getBoundingClientRect() ?? new DOMRect();
      // THE PAINTED TEXT, NOT THE ELEMENT'S BOX. This is the whole reason the probe
      // can see the defect at all: the old shape gave each header cell a ~37px box
      // and the label PAINTED PAST IT — the element rects never overlapped, only the
      // glyphs did, which is exactly what "TelegramPush" is. A Range over the node's
      // contents measures where the text actually landed, for an inline span and a
      // block one alike.
      const textBox = (el: Element | null) => {
        if (!el) return new DOMRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const r = range.getBoundingClientRect();
        range.detach();
        return r.width > 0 || r.height > 0 ? r : el.getBoundingClientRect();
      };
      const card = document.querySelector<HTMLElement>(
        '[data-testid="notification-kinds"]'
      );
      const chipsIn = (scope: Element | null, control: (c: string) => string) =>
        channels.map((c) => {
          const label = scope?.querySelector<HTMLElement>(
            `[data-matrix-chip-label][data-testid="matrix-chip-${c}-${kind}"]`
          );
          // In the header the chip has no `data-matrix-chip-label`: its name is the
          // first child span of the head cell.
          const head = scope?.querySelector<HTMLElement>(
            `[data-matrix-head-cell="${c}"]`
          );
          const nameEl = label ?? head?.querySelector<HTMLElement>("span");
          const chipEl =
            (label?.closest("[data-matrix-cell]") as HTMLElement | null) ??
            head ??
            null;
          const boxEl = scope?.querySelector<HTMLElement>(control(c)) ?? null;
          const chip = box(chipEl);
          const name = textBox(nameEl ?? null);
          const b = box(boxEl);
          return {
            id: c,
            left: chip.left,
            right: chip.right,
            top: chip.top,
            bottom: chip.bottom,
            labelLeft: name.left,
            labelRight: name.right,
            labelCy: name.top + name.height / 2,
            labelText: (nameEl?.textContent ?? "").trim(),
            boxLeft: b.left,
            boxCx: b.left + b.width / 2,
            boxCy: b.top + b.height / 2,
            boxVisible: b.width > 0 && b.height > 0,
          };
        });

      const headStrip =
        document.querySelector<HTMLElement>("[data-matrix-head]");
      const rowEl = document.querySelector<HTMLElement>(
        `[data-testid="kind-row-${kind}"]`
      );
      const titleLeft = (k: string) =>
        box(
          document.querySelector(
            `[data-testid="kind-row-${k}"] [data-matrix-kind-title]`
          )
        ).left;

      const meta = ["kinds-intro", "matrix-ink-legend"]
        .map((id) =>
          document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
        )
        .filter((el): el is HTMLElement => el !== null)
        .map((el) => ({
          height: el.getBoundingClientRect().height,
          lineHeight: parseFloat(getComputedStyle(el).lineHeight) || 16,
        }));

      const sweepLabel = document.querySelector<HTMLElement>(
        '[data-testid="matrix-sweep-label"]'
      );
      const paint = (el: Element | null) => {
        const cs = el ? getComputedStyle(el) : null;
        return {
          background: cs?.backgroundColor ?? "",
          borderTopWidth: parseFloat(cs?.borderTopWidth ?? "0") || 0,
        };
      };

      return {
        channelCount:
          headStrip?.querySelectorAll("[data-matrix-head-cell]").length ?? 0,
        kindCount: document.querySelectorAll("[data-matrix-row]").length,
        cardWidth: box(card).width,
        head: chipsIn(
          headStrip,
          (c) => `[data-testid="matrix-column-all-${c}"]`
        ),
        row: chipsIn(
          rowEl,
          (c) =>
            `[data-testid="matrix-cell-${c}-${kind}"], [data-testid="matrix-unavailable-${c}-${kind}"]`
        ),
        rowTextBottom: box(rowEl?.querySelector("[data-matrix-kind]") ?? null)
          .bottom,
        rowChipsTop: box(rowEl?.querySelector("[data-matrix-channels]") ?? null)
          .top,
        safetyTitleLeft: titleLeft("dose"),
        toggleableTitleLeft: titleLeft("preventive"),
        metaHeights: meta,
        sweepPanel: {
          labelText: (sweepLabel?.textContent ?? "").trim(),
          labelPainted: !!(
            sweepLabel &&
            sweepLabel.getBoundingClientRect().width > 0 &&
            sweepLabel.getBoundingClientRect().height > 0
          ),
          ...paint(headStrip),
        },
        rowPanel: paint(rowEl?.querySelector("[data-matrix-channels]") ?? null),
      };
    },
    { kind, channels: [...channels] }
  );
}

/** Boxes that overlap horizontally AND vertically — a real collision, not two lines. */
function collisions(chips: Chip[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < chips.length; i += 1)
    for (let j = i + 1; j < chips.length; j += 1) {
      const a = chips[i];
      const b = chips[j];
      const overlapX = a.labelLeft < b.labelRight && b.labelLeft < a.labelRight;
      const sameLine = Math.abs(a.labelCy - b.labelCy) < 4;
      if (overlapX && sameLine)
        out.push(`${a.id} "${a.labelText}" overlaps ${b.id} "${b.labelText}"`);
    }
  return out;
}

/**
 * Every routing checkbox, with the text a sighted reader sees beside it and the name
 * assistive technology and speech input get. WCAG 2.5.3 (Label in Name, Level A) is
 * the check: the accessible name must CONTAIN the visible label text, or a speech
 * user saying what they can see cannot reach the control.
 *
 * The name is read off `aria-label`, which is what the accname computation resolves
 * to for these inputs — proved once, against Playwright's own computation, by the
 * `toHaveAccessibleName` assertion beside the first use of this probe.
 */
async function readLabelInName(page: Page) {
  return page.evaluate(() =>
    [
      ...document.querySelectorAll<HTMLInputElement>(
        '[data-matrix-cell] input[type="checkbox"]'
      ),
    ].map((input) => {
      const chip = input
        .closest("[data-matrix-cell]")
        ?.querySelector<HTMLElement>("[data-matrix-chip-label]");
      const r = chip?.getBoundingClientRect();
      return {
        testid: input.getAttribute("data-testid") ?? "",
        visible:
          chip && r && r.width > 0 && r.height > 0
            ? (chip.textContent ?? "").trim()
            : "",
        name: input.getAttribute("aria-label") ?? "",
      };
    })
  );
}

test.describe("Message kinds at phone width (#3495)", () => {
  test("the channel columns become labeled chips that fit, on one baseline", async ({
    page,
    browser,
  }) => {
    test.slow(); // local next dev compiles /settings/notifications on first hit

    // The project's viewport really is inside card mode — otherwise this whole file
    // is measuring the desktop arrangement and its silence means nothing.
    const viewport = page.viewportSize();
    expect(
      viewport?.width,
      "this spec belongs to the `mobile` project, whose viewport must be below " +
        "the card-mode boundary for any of it to be a claim about a phone"
    ).toBe(PHONE_WIDTH);
    expect(PHONE_WIDTH).toBeLessThan(CARD_MODE_BREAKPOINT_PX);

    const member = await loginAs(
      browser,
      { username: E2E_LOGIN_MATRIX_PHONE, password: E2E_MEMBER_PASSWORD },
      // `browser.newContext()` does not inherit a project's `use`, so the phone
      // viewport is passed explicitly — READ OFF the project's own page rather than
      // typed a second time.
      { viewport, hasTouch: true }
    );
    try {
      await member.goto(ROUTE);
      const kinds = member.getByTestId("notification-kinds");
      await expect(kinds).toBeVisible();
      // WAIT FOR THE CONTENT, NOT THE CONTAINER (#3384): a card measured between its
      // shell and its list is measuring an empty box, and empty fits.
      await expect(member.getByTestId(`kind-row-${SAFETY_KIND}`)).toHaveCount(
        1
      );
      await expect(
        member.getByTestId(`matrix-column-all-${GHOST_CHANNEL}`)
      ).toBeVisible();

      const shape = await readShape(member, GHOST_KIND, CHANNEL_IDS);

      // ── THE CORPUS, RE-DERIVED ────────────────────────────────────────────
      // Both counts are read off the render, not off the issue. The issue says
      // "four channels" and "N kinds"; these are what the page actually drew.
      expect(
        shape.channelCount,
        "the header strip did not render one chip per channel — every geometry " +
          "verdict below is then an assertion over an empty corpus"
      ).toBe(CHANNEL_IDS.length);
      expect(
        shape.kindCount,
        "fewer kind rows than the registry's unconditional set; the probe is " +
          "reading a page that did not finish rendering"
      ).toBeGreaterThanOrEqual(12);
      expect(shape.cardWidth).toBeGreaterThan(0);

      // ── (1) NO HEADER LABEL LEAVES ITS OWN CHIP, AND NONE COLLIDES ────────
      // This is "TelegramPush", measured. Two readings, because they fail for
      // different reasons: a label wider than its own chip is the overflow, and two
      // labels sharing a line and a band of x is the collision it produced.
      for (const chip of shape.head) {
        expect(
          chip.labelRight,
          `the "${chip.labelText}" header label paints past its own chip ` +
            `(label right ${Math.round(chip.labelRight)} vs chip right ` +
            `${Math.round(chip.right)}) — that overflow is what rendered as ` +
            `"TelegramPush" at ${PHONE_WIDTH}px.`
        ).toBeLessThanOrEqual(chip.right + 1);
      }
      expect(
        collisions(shape.head),
        "two channel labels are painted over each other at " +
          `${PHONE_WIDTH}px — the #3495 defect.`
      ).toEqual([]);

      // ── (2) EVERY SWEEP BOX IS ON ITS OWN CHANNEL'S LINE ──────────────────
      // "The controls that sweep a column, aligned with it." The old shape put the
      // box under a stack of unpredictable height, so the four ended up on four
      // baselines; the chip puts each box beside the name it sweeps.
      for (const chip of shape.head) {
        expect(chip.boxVisible, `${chip.id}'s sweep box did not render`).toBe(
          true
        );
        expect(
          Math.abs(chip.boxCy - chip.labelCy),
          `${chip.id}'s sweep box sits ${Math.round(
            Math.abs(chip.boxCy - chip.labelCy)
          )}px off the vertical centre of the channel name it sweeps`
        ).toBeLessThanOrEqual(3);
        expect(
          chip.boxLeft,
          `${chip.id}'s sweep box is not the first thing in its chip — the box ` +
            `leads, then the channel it sweeps`
        ).toBeLessThan(chip.labelLeft);
      }
      // …and no box invents a baseline of its own: the number of distinct box lines
      // equals the number of distinct label lines. Measured 2026-08-22 at 390px: the
      // four chips occupy 2 lines. The claim is the EQUALITY, not the 2.
      const lines = (ys: number[]) =>
        new Set(ys.map((y) => Math.round(y / 4))).size;
      expect(
        lines(shape.head.map((c) => c.boxCy)),
        "the sweep boxes sit on more baselines than the channel names do — " +
          "which is the four-different-baselines defect in its general form"
      ).toBe(lines(shape.head.map((c) => c.labelCy)));

      // ── (3) A KIND'S CHANNELS ARE LABELED, AND BELOW ITS OWN TEXT ─────────
      for (const chip of shape.row) {
        expect(
          chip.labelText,
          `the ${chip.id} chip on the ${GHOST_KIND} row carries no visible label`
        ).not.toBe("");
        expect(
          Math.abs(chip.boxCy - chip.labelCy),
          `the ${chip.id} chip's control is off its own label's line`
        ).toBeLessThanOrEqual(3);
      }
      expect(
        shape.rowChipsTop,
        "the channel chips are still sharing a line with the kind's title and " +
          "description, so each kind is not its own block (#3495's ruling)"
      ).toBeGreaterThanOrEqual(shape.rowTextBottom - 1);

      // ── (4) THE WAITING STATE IS LEGIBLE AT THE CONTROL ───────────────────
      // The faded tick's meaning used to live only in the legend box. Home Assistant
      // is unconfigured on this profile, so its kept ticks are ghosts.
      await expect(
        member.getByTestId(`matrix-column-state-${GHOST_CHANNEL}`)
      ).toHaveText("not set up");
      const ghostCell = member.getByTestId(
        `matrix-cell-${GHOST_CHANNEL}-${GHOST_KIND}`
      );
      await expect(ghostCell).toHaveAttribute("data-ink", "ghost");
      // The chip names its channel with the SAME label the accessible name uses —
      // "Home Assistant", not the column's 2-letter short form — and its state word
      // is the start of the accessible name's note ("kept", from "kept, waiting on
      // this channel's setup"). That pairing is WCAG 2.5.3, asserted over every cell
      // below; this is the one string spelled out.
      await expect(
        member.getByTestId(`matrix-chip-${GHOST_CHANNEL}-${GHOST_KIND}`)
      ).toHaveText("Home Assistant — kept");

      // ── (5) SAFETY KINDS: NO TOGGLE, AND STILL ALIGNED ────────────────────
      await expect(
        member.getByTestId(`kind-enable-${SAFETY_KIND}`)
      ).toHaveCount(0);
      expect(
        Math.abs(shape.safetyTitleLeft - shape.toggleableTitleLeft),
        `the ${SAFETY_KIND} title starts ${Math.round(
          shape.toggleableTitleLeft - shape.safetyTitleLeft
        )}px left of the ${TOGGLEABLE_KIND} title — the missing master toggle ` +
          `has to reserve its slot below the boundary, not shift the row`
      ).toBeLessThanOrEqual(1);

      // ── (5b) THE COLUMN SWEEP SAYS WHAT IT DOES, VISIBLY ─────────────────
      // #3550's review. One tap on a sweep box turns off every non-safety kind on
      // that channel — 12 of the 14 — with no confirm and no undo. Before this the
      // only disclosure was `columnBulkLabel` as `title` and accessible name, and
      // NEITHER reaches a sighted phone user: `title` needs a hover a touch device
      // does not have. Two readings, because the fix has two halves and either alone
      // leaves the regression standing.
      expect(
        shape.sweepPanel.labelPainted,
        "the sweep row carries no visible label at " +
          `${PHONE_WIDTH}px, so nothing on screen says that its four boxes write ` +
          "every kind at once"
      ).toBe(true);
      expect(
        shape.sweepPanel.labelText.toLowerCase(),
        "the sweep row's label does not name the safety carve-out, so it " +
          "overstates what a tap does"
      ).toContain("safety");
      // …and the strip is no longer painted like a kind's own line of chips. The
      // defect was an IDENTITY: same left edge, same 16px box, same 12px font, same
      // colour as the routing chips 133px below. A framed, tinted panel is what
      // breaks it, so that is what is measured — against the row's chip line, read
      // in the same pass.
      expect(
        shape.sweepPanel.background,
        "the sweep strip paints no background of its own, so it still reads as " +
          "one more line of routing chips"
      ).not.toBe(shape.rowPanel.background);
      expect(
        shape.sweepPanel.borderTopWidth,
        "the sweep strip has no frame around it; the routing chips have none " +
          "either, which is exactly the identity #3550 flagged"
      ).toBeGreaterThan(shape.rowPanel.borderTopWidth);
      expect(
        Math.abs(shape.head[0].boxLeft - shape.row[0].boxLeft),
        "a sweep box still starts at the same x as a routing box on the rows " +
          "below — the measurement that made the two indistinguishable"
      ).toBeGreaterThan(1);

      // ── (5c) WCAG 2.5.3, LABEL IN NAME (Level A) ──────────────────────────
      // The chip label sits inside the `<label>` that wraps the checkbox, so below
      // the boundary the control has a VISIBLE label — which it does not have at
      // desktop, where the chip is `hidden`. `aria-label` wins the accessible-name
      // computation, so unless the visible text is contained in it a speech-input
      // user saying what they can see cannot reach the control. The accessible name
      // is ONE string at every width, so the property is kept by shortening the
      // VISIBLE text into the name rather than by rewording the name: the chip uses
      // the channel label the name uses, and `cellInkChipNote` is a leading
      // substring of `cellInkNote` (held in lib/__tests__/matrix-liveness.test.ts).
      const cells = await readLabelInName(member);
      expect(
        cells.length,
        "no routing checkbox rendered a visible chip label, so the 2.5.3 verdict " +
          "below is an absence over an empty corpus"
      ).toBeGreaterThanOrEqual(12);
      expect(
        cells
          .filter((c) => c.visible !== "" && !c.name.includes(c.visible))
          .map((c) => `${c.testid}: visible "${c.visible}" ∉ name "${c.name}"`),
        "a checkbox's visible label is not contained in its accessible name — " +
          "WCAG 2.5.3 (Label in Name, Level A). Introduced at phone width: at " +
          "desktop these checkboxes have no visible label at all."
      ).toEqual([]);
      // The probe reads `aria-label`; this is the one assertion that proves that is
      // what the accname computation actually resolves to for this element.
      await expect(ghostCell).toHaveAccessibleName(
        cells.find(
          (c) => c.testid === `matrix-cell-${GHOST_CHANNEL}-${GHOST_KIND}`
        )!.name
      );

      // ── (6) THE META BUDGET ───────────────────────────────────────────────
      // "Meta copy before the first control fits in ~3 lines at 390px." Read as
      // lines, which is the unit the criterion is written in.
      expect(
        shape.metaHeights.length,
        "neither the intro nor the ink legend rendered, so the line count below " +
          "is a claim about nothing"
      ).toBeGreaterThan(0);
      const metaLines = shape.metaHeights.reduce(
        (n, m) => n + Math.round(m.height / m.lineHeight),
        0
      );
      expect(
        metaLines,
        `the explanatory copy above the first control is ${metaLines} lines at ` +
          `${PHONE_WIDTH}px; the ruling budgets about three. (The actionable ` +
          `per-login/per-profile setup bullets are deliberately not counted — ` +
          `they are steps, not meta. Neither is the sweep row's own label, for ` +
          `the same reason: it names the control it sits on rather than ` +
          `explaining the page, and #3550 required exactly that disclosure.)`
      ).toBeLessThanOrEqual(3);

      // ── (7) NOTHING OVERFLOWS THE VIEWPORT ────────────────────────────────
      await expectNoClippedContent(member);
    } finally {
      await member.context().close();
    }
  });

  test("a chip for an unconfigured channel edits the same kept preference the box does", async ({
    page,
    browser,
  }) => {
    test.slow();
    const viewport = page.viewportSize();
    const member = await loginAs(
      browser,
      { username: E2E_LOGIN_MATRIX_PHONE, password: E2E_MEMBER_PASSWORD },
      { viewport, hasTouch: true }
    );
    try {
      await member.goto(ROUTE);
      const cell = member.getByTestId(
        `matrix-cell-${GHOST_CHANNEL}-${GHOST_KIND}`
      );
      const chip = member.getByTestId(
        `matrix-chip-${GHOST_CHANNEL}-${GHOST_KIND}`
      );
      await expect(cell).toBeVisible();
      await expect(chip).toBeVisible();

      // Same optimistic-flip re-click discipline the matrix cases document: a routing
      // cell fires its action from a CLIENT onChange, so a tap landing in the
      // hydration window is silently swallowed with no navigation to follow (#830).
      const tapChip = async (to: boolean) => {
        await expect(async () => {
          await chip.click();
          await expect(cell).toBeChecked({ checked: to });
        }).toPass(); // topass-ok: re-tap the chip until the optimistic flip proves onChange fired — "my tap landed" is non-atomic with no navigation to follow (#830)
        await expect(cell).toBeEnabled();
      };

      // Drive to a known state first — a --repeat-each run re-enters with the
      // previous run's writes.
      if (!(await cell.isChecked())) await tapChip(true);
      await expect(cell).toHaveAttribute("data-ink", "ghost");

      // The chip's LABEL is the control. It writes the same stored preference, and the
      // ghost/off inequality survives the round trip.
      await tapChip(false);
      await expect(cell).toHaveAttribute("data-ink", "off");
      await member.reload();
      await expect(
        member.getByTestId(`matrix-cell-${GHOST_CHANNEL}-${GHOST_KIND}`)
      ).not.toBeChecked();

      // Leave the fixture as we found it.
      await tapChip(true);
      await expect(cell).toHaveAttribute("data-ink", "ghost");
    } finally {
      await member.context().close();
    }
  });

  test("the probe can SEE a collided header — the old 40px columns, forged", async ({
    page,
    browser,
  }) => {
    test.slow();
    const viewport = page.viewportSize();
    const member = await loginAs(
      browser,
      { username: E2E_LOGIN_MATRIX_PHONE, password: E2E_MEMBER_PASSWORD },
      { viewport, hasTouch: true }
    );
    try {
      await member.goto(ROUTE);
      await expect(member.getByTestId("notification-kinds")).toBeVisible();
      await expect(
        member.getByTestId(`matrix-column-all-${GHOST_CHANNEL}`)
      ).toBeVisible();

      const fixed = await readShape(member, GHOST_KIND, CHANNEL_IDS);
      expect(collisions(fixed.head)).toEqual([]);

      // FORGED BY A SPEC on purpose — never a real render. This puts the header strip
      // back the way #3495 found it at the SAME width: four columns inside 160px, each
      // channel's name stacked over its state over its box. If the probe cannot call
      // this collided, then its clean verdict above was never a measurement.
      await member.evaluate(() => {
        // `!important` on both sides: the phone rules carry it (they override the
        // call site's own utilities), so a plain inline style would lose to them and
        // the "forgery" would silently be a no-op — a probe test that proves nothing
        // while passing is the failure this case exists to avoid.
        const set = (el: HTMLElement, prop: string, value: string) =>
          el.style.setProperty(prop, value, "important");
        const strip = document.querySelector<HTMLElement>(
          "[data-matrix-head] [data-matrix-channels]"
        )!;
        set(strip, "display", "grid");
        set(strip, "grid-template-columns", "repeat(4, minmax(0, 1fr))");
        set(strip, "width", "160px");
        set(strip, "text-align", "center");
        for (const cell of strip.querySelectorAll<HTMLElement>(
          "[data-matrix-head-cell]"
        )) {
          set(cell, "display", "block");
          for (const child of cell.querySelectorAll<HTMLElement>("span"))
            set(child, "display", "block");
        }
      });

      const forged = await readShape(member, GHOST_KIND, CHANNEL_IDS);
      // The OTHER reading the fixed shape asserts: at least one label now paints past
      // its own cell. Both directions of the probe are exercised, because the two
      // assertions above fail for different reasons.
      expect(
        forged.head.filter((c) => c.labelRight > c.right + 1).map((c) => c.id),
        "no forged header label paints past its own 40px cell, so the overflow " +
          "half of the probe cannot see either"
      ).not.toEqual([]);
      expect(
        collisions(forged.head),
        "the geometry probe did NOT see header labels it was just made to " +
          "collide, so its clean readings above mean nothing — the probe has " +
          "gone blind."
      ).not.toEqual([]);
    } finally {
      await member.context().close();
    }
  });
});

test.describe("Message kinds at desktop width — unchanged (#3495)", () => {
  test("the matrix is still four equal columns under four sweeps, and the chips are not painted", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(
      browser,
      { username: E2E_LOGIN_MATRIX_PHONE, password: E2E_MEMBER_PASSWORD },
      { viewport: DESKTOP }
    );
    try {
      await member.goto(ROUTE);
      await expect(member.getByTestId("notification-kinds")).toBeVisible();
      await expect(member.getByTestId(`kind-row-${GHOST_KIND}`)).toHaveCount(1);

      // The chip labels exist in the one DOM and are NOT painted here.
      for (const c of CHANNEL_IDS)
        await expect(
          member.getByTestId(`matrix-chip-${c}-${GHOST_KIND}`)
        ).toBeHidden();
      // Nor is the sweep row's label: at desktop the boxes sit under the channel
      // names in a two-column header whose left cell says "Kind", and #3495 rules
      // that arrangement unchanged. This is the assertion that fails if the #3550
      // disclosure leaks past the card-mode boundary.
      await expect(member.getByTestId("matrix-sweep-label")).toBeHidden();
      await expect(member.getByText("Kind", { exact: true })).toBeVisible();

      const shape = await readShape(member, GHOST_KIND, CHANNEL_IDS);
      expect(shape.channelCount).toBe(CHANNEL_IDS.length);

      // WCAG 2.5.3's OTHER half, and the reason the phone case exists at all: at
      // desktop these checkboxes have no visible label, so the success criterion
      // does not apply here and never did. Read off the same probe, so the two
      // widths are one claim rather than two.
      const cells = await readLabelInName(member);
      expect(
        cells.filter((c) => c.visible !== "").map((c) => c.testid),
        "a routing checkbox grew a visible label at desktop width; the chip is " +
          "card-mode-only and #3495 rules the desktop matrix unchanged"
      ).toEqual([]);

      // Four cells, one baseline, evenly spaced — the desktop grid, measured.
      const cys = shape.row.map((c) => c.boxCy);
      expect(
        Math.max(...cys) - Math.min(...cys),
        "the four routing boxes are no longer on one line at desktop width"
      ).toBeLessThanOrEqual(1);
      const gaps = shape.row
        .slice(1)
        .map((c, i) => c.boxCx - shape.row[i].boxCx);
      expect(
        Math.max(...gaps) - Math.min(...gaps),
        "the four routing columns are no longer evenly spaced at desktop width"
      ).toBeLessThanOrEqual(1);

      // Each sweep box is centred over the column it sweeps — the desktop reading
      // ("the box under a channel name") the phone shape replaces rather than moves.
      const boxes = await settledBoxes(
        CHANNEL_IDS.map((c) => member.getByTestId(`matrix-column-all-${c}`))
      );
      boxes.forEach((b, i) => {
        expect(
          Math.abs(b.x + b.width / 2 - shape.row[i].boxCx),
          `the ${CHANNEL_IDS[i]} sweep box is no longer centred over its own column`
        ).toBeLessThanOrEqual(1);
      });

      // AND THE PHONE-ONLY ALIGNMENT FIX IS NOT APPLIED HERE. A safety kind carries
      // no master toggle, so its title still starts left of a toggleable kind's —
      // exactly as it did before #3495. This is the assertion that would fail if the
      // reserved slot leaked past the card-mode boundary.
      expect(
        shape.toggleableTitleLeft - shape.safetyTitleLeft,
        `the ${SAFETY_KIND} row grew a reserved toggle slot at desktop width; ` +
          `that slot is card-mode-only, and #3495 rules the desktop matrix ` +
          `unchanged`
      ).toBeGreaterThan(4);
    } finally {
      await member.context().close();
    }
  });
});
