import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { HOVER_CAPTURES } from "../scripts/ux-census-routes.mjs";
import { HOVER_THRESHOLDS, measureHover } from "../scripts/ux-hover-census.mjs";

// THE GUARD FOR THE UX CENSUS'S HOVER CAPTURES (#3489, deliverable 4).
//
// The capture pass is a seeing tool: it MEASURES and never asserts, and its output
// is `…-hover.png` files plus a table in the run's audit.md that a person reads.
// #3489 puts "making any of this a CI gate" explicitly out of scope, and it could
// not be one anyway — #3375 is OPEN, so a spec demanding that every hover-only fact
// be reachable would be red on arrival and would get its routes trimmed until it
// was green, which is how a census loses its coverage.
//
// What this file asserts instead is that THE PROBE CAN SEE, which is the half a
// seeing tool cannot check for itself — and the shape of the claim makes that
// mandatory rather than nice. "This surface hides no information behind hover" is
// an ABSENCE assertion, and an absence assertion FAILS OPEN: it goes green the
// moment the probe stops finding anything at all. A registry whose selectors have
// all rotted produces a clean run. So, three ways, none of them an assertion about
// the app's own quality:
//
//   1. A CENSUS FLOOR per registered surface — how many rendered elements the
//      snapshot actually examined. A probe pointed at a shell, a 404 or a `<body>`
//      that never hydrated comes in an order of magnitude under.
//   2. A NAMED SUBJECT per surface — the registry's own hover target, required to
//      be among the elements examined. A count says "something was here"; the
//      subject says "the thing you are making a claim about was here". #3522's
//      lesson runs the other way and is why the floor is not enough on its own: a
//      too-narrow selector fails toward "the surface never rendered", which on an
//      absence assertion MANUFACTURES work rather than hiding it.
//   3. A SYNTHETIC OFFENDER — a real CSS `:hover` rule that reveals text — planted
//      in a live DOM and required back, AND its benign twin, a hover target that
//      changes nothing, required to come back as a no-op. Both halves are the
//      guard. A probe that called every hover a reveal would put a picture of
//      nothing beside every real one, and it would be deleted within a week taking
//      the real probe with it (#3325's lesson).
//
// The forgery is bound to the assertion in ONE call — `expectHoverProbeSees` —
// deliberately, copying `expectAtomicCardPairs` in e2e/helpers.ts: a future surface
// added to SURFACES cannot get the floor and the subject while quietly skipping the
// half that proves the probe is not blind. That is tracked as #3509.
//
// EVERY READING IS RENDERED. `.standing-row:hover .standing-door { opacity: 1 }` is
// a DECLARATION; what is measured here is the engine's own `checkVisibility()` and
// the bytes of two clipped PNGs. The forged offender below is therefore given a
// real stylesheet and hovered with a real pointer — not a class toggled by script,
// which would prove only that the probe can read the DOM it was handed.
//
// DESKTOP. The whole deliverable is desktop-only (a phone has no hover), so this
// file deliberately carries no `.mobile.` in its name and runs in the default
// 1280×900 project.
//
// Fixture (#868 hygiene): READ-ONLY. Nothing is written; every forgery is a DOM
// node appended to a page that is about to be discarded, never a database row.

interface Surface {
  /** Which HOVER_CAPTURES entry this covers. */
  route: string;
  /** What this surface is in the guard FOR. */
  why: string;
  /**
   * (1) A floor on how many rendered elements the snapshot examined, set from a
   * measured run and rounded DOWN hard. It separates "this page rendered" from
   * "this page did not"; it is NOT a content pin, and the difference matters — a
   * floor anywhere near a measurement is a flake waiting to happen. The reading it
   * was cut from is in the comment beside it.
   */
  minExamined: number;
}

const SURFACES: Surface[] = [
  {
    route: "/",
    why: "The dashboard's Standing cluster: #3459 item 2's door labels, the named miss this deliverable exists for.",
    // measured 2647, 2647, 2647 across --repeat-each=3 on 2026-08-22
    minExamined: 900,
  },
  {
    route: "/records/history/immunizations",
    why: "The CDC schedule grid: #3375's load-bearing case, where the mouse panel is the ONLY path to the content.",
    // measured 1465, 1465, 1465 (schedule disclosure open) across --repeat-each=3
    minExamined: 500,
  },
];

interface HoverEntry {
  route: string;
  label: string;
  target: string;
  reveals?: string;
  openFirst?: string;
  ruling: string;
}

// Paired at module load, so a SURFACES entry naming a route the registry no longer
// carries fails COLLECTION rather than being quietly skipped. The other direction —
// a registered entry with no floor here — is the first test below.
const REGISTERED: { surface: Surface; entry: HoverEntry }[] = SURFACES.map(
  (surface) => {
    const entry = (HOVER_CAPTURES as HoverEntry[]).find(
      (e) => e.route === surface.route
    );
    if (!entry)
      throw new Error(
        `e2e/ux-hover-capture.spec.ts guards ${surface.route}, which is no longer ` +
          `in HOVER_CAPTURES (scripts/ux-census-routes.mjs)`
      );
    return { surface, entry };
  }
);

// ── THE FORGERIES ─────────────────────────────────────────────────────────────
//
// A real stylesheet and real geometry, never a class the app owns: borrowing
// `.standing-row` would make this fail the day somebody renames it for an
// unrelated reason, and would put the app's own DECLARATION back in the middle of
// a measurement of the probe.
//
// `position: absolute` at the document origin, with the page scrolled to the top,
// so viewport coordinates and document coordinates coincide — the clip the probe
// cuts is in document coordinates, and a `position: fixed` host would put the two
// systems a scroll offset apart. The host is opaque and large enough that the
// probe's 24px region padding stays inside it, so nothing underneath can bleed
// into the comparison and make the NO-OP twin read as changed.
const FORGED_HOST_ID = "forged-hover-host";
const FORGED_REVEAL = "forged-hover-reveal";
const FORGED_NOOP = "forged-hover-noop";
const FORGED_PAYLOAD_TEXT = "door label six";

function plantForgedHovers(): void {
  const style = document.createElement("style");
  // Literals, not the module constants above: `page.evaluate` serializes this
  // function's SOURCE into the page, so it can reference nothing from module scope.
  style.textContent =
    "#forged-hover-reveal .forged-payload { opacity: 0 }" +
    "#forged-hover-reveal:hover .forged-payload { opacity: 1 }";
  const host = document.createElement("div");
  host.id = "forged-hover-host";
  host.appendChild(style);
  host.setAttribute(
    "style",
    "position:absolute;left:0;top:0;width:640px;height:420px;" +
      "background:#ffffff;z-index:2147483000"
  );
  host.insertAdjacentHTML(
    "beforeend",
    // The offender: hovering it makes a span go from opacity 0 to 1. This is the
    // exact mechanism app/globals.css uses for the standing door, which is why a
    // probe that reads boxes alone would see nothing here — the payload's
    // rectangle is identical in both states.
    '<div id="forged-hover-reveal" style="position:absolute;left:80px;top:80px;' +
      'width:240px;height:44px;background:#ffffff">' +
      '<span class="forged-payload">door label six</span></div>' +
      // The benign twin: a target with no hover rule at all. Hovering it must
      // change nothing — no pixels, no visibility, no movement — because that is
      // the case whose picture the census must NOT take.
      '<div id="forged-hover-noop" style="position:absolute;left:80px;top:240px;' +
      'width:240px;height:44px;background:#ffffff">no-op target</div>'
  );
  document.body.appendChild(host);
  window.scrollTo(0, 0);
}

function removeForgedHovers(): void {
  document.getElementById("forged-hover-host")?.remove();
}

/**
 * THE ASSERTION AND ITS DISCRIMINATOR, IN ONE CALL (the `expectAtomicCardPairs`
 * pattern, #3509). The floor and the named subject are the census half; the two
 * forgeries are the half that proves the census half meant something. Binding them
 * means a new surface added to SURFACES cannot take the reassuring measurement and
 * skip the proof.
 *
 * The control AFTER the restore is not ceremony: the forged host is an opaque
 * 640×420 panel over the page's top-left corner, and a plant that failed to clean
 * up would leave every later reading in this file measuring a white box.
 */
async function expectHoverProbeSees(
  page: Page,
  surface: Surface,
  entry: HoverEntry
): Promise<void> {
  const clean = await measureHover(page, entry, {
    ...HOVER_THRESHOLDS,
    subjectSelector: entry.target,
  });

  // KEEP THIS, reviewer. It is how the floor above was derived and how the next
  // person re-derives it, and it is what makes a red here say WHICH reading
  // collapsed instead of only that one did. It is also the run's only record of
  // what the REAL affordance did, which this file deliberately does not assert on
  // (the census is a seeing tool, not a gate — see the header).
  console.log(
    `[#3489 hover probe] ${surface.route} "${entry.label}": ` +
      `${clean.examined} elements examined, ${clean.revealedTotal} revealed, ` +
      `${clean.hiddenTotal} hidden, ${clean.movedTotal} moved, ` +
      `pixels ${clean.pixelsChanged ? "changed" : "identical"}`
  );

  expect(
    clean.regionMeasured,
    `${surface.route}: no clip region could be cut around \`${entry.target}\`, so ` +
      `neither PNG was taken and the pixel half of the verdict was silently absent.`
  ).toBe(true);

  expect(
    clean.examined,
    `${surface.route}: the snapshot examined only ${clean.examined} rendered ` +
      `elements, under the floor of ${surface.minExamined}. It is not looking at ` +
      `this page — ${surface.why}`
  ).toBeGreaterThanOrEqual(surface.minExamined);

  expect(
    clean.subjectExamined,
    `${surface.route}: \`${entry.target}\` is on screen but was NOT among the ` +
      `elements the snapshot examined, so this surface's verdict is about ` +
      `something else. An absence verdict from a probe that cannot reach its own ` +
      `target is the failure that reads exactly like a clean sweep.`
  ).toBe(true);

  // ── THE BENIGN TWIN, ON ITS OWN FIRST ───────────────────────────────────────
  // Measured alone, so a probe that calls every hover a change cannot hide inside
  // the offender's own delta.
  await page.evaluate(plantForgedHovers);
  const noop = await measureHover(
    page,
    { target: `#${FORGED_NOOP}` },
    HOVER_THRESHOLDS
  );
  expect(
    {
      changed: noop.changed,
      revealed: noop.revealed,
      pixels: noop.pixelsChanged,
    },
    "the probe reported a change from hovering an element with no hover rule at " +
      "all. Every registered surface would then get a `-hover.png` byte-identical " +
      "to its default shot, and a reviewer would learn to skip the whole table."
  ).toEqual({ changed: false, revealed: [], pixels: false });

  // ── THE OFFENDER ────────────────────────────────────────────────────────────
  const caught = await measureHover(
    page,
    { target: `#${FORGED_REVEAL}`, reveals: ".forged-payload" },
    HOVER_THRESHOLDS
  );
  expect(
    caught.revealed.map((r) => r.text),
    "the probe did not see text that a real CSS `:hover` rule took from opacity 0 " +
      "to opacity 1 under a real pointer. It is reading a declaration, or its " +
      "visibility test no longer accounts for opacity — which is the exact " +
      "mechanism app/globals.css uses for the standing door."
  ).toContain(FORGED_PAYLOAD_TEXT);
  expect(caught.revealsInformation).toBe(true);
  // The rectangle did NOT move: an opacity reveal is invisible to a box reading,
  // which is why `checkVisibility` and the PNG bytes are both in the verdict.
  expect(
    caught.pixelsChanged,
    "the two clipped PNGs came back byte-identical across a reveal that painted " +
      "text into the region. The clip is being cut somewhere other than where the " +
      "payload rendered."
  ).toBe(true);

  // ── AND THE HOVER SURVIVES THE CAPTURE ──────────────────────────────────────
  // The deliverable is a PICTURE. A full-page screenshot that dropped the hover
  // state would leave every `-hover.png` showing the resting state while the table
  // beside it swore something was revealed — the worst available outcome, because
  // the shot would be read as evidence.
  const payloadPainted = () =>
    page
      .locator(".forged-payload")
      .evaluate((el: Element) => el.checkVisibility({ opacityProperty: true }));
  await page.locator(`#${FORGED_REVEAL}`).hover();
  // Wait for the REVEAL, not for a clock. The opacity transition finishing is the
  // signal, and polling it is both faster than the settle budget and immune to a
  // box slow enough to blow through it.
  await expect.poll(payloadPainted).toBe(true);
  await page.screenshot({ fullPage: true });
  expect(
    await payloadPainted(),
    "the hover state did not survive a full-page screenshot, so every `-hover.png` " +
      "the census writes is a picture of the resting state."
  ).toBe(true);

  // ── RESTORE, AND CONTROL AFTER THE RESTORE ──────────────────────────────────
  await page.evaluate(removeForgedHovers);
  expect(
    await page.locator(`#${FORGED_HOST_ID}`).count(),
    "the forged host is still in the DOM — every later reading in this file is " +
      "measuring an opaque white panel."
  ).toBe(0);
}

test.describe("the census hover pass can see what only hover shows (#3489)", () => {
  // Every registered entry must have a guard entry. Without this, adding a route to
  // HOVER_CAPTURES gives it a capture nothing has ever proved the probe can reach —
  // and its BLIND SPOT line would read the same whether the surface has no hover
  // state or the selector was simply wrong.
  test("guards every registered hover capture", () => {
    const guarded = new Set(SURFACES.map((s) => s.route));
    const missing = (HOVER_CAPTURES as HoverEntry[])
      .filter((e) => !guarded.has(e.route))
      .map((e) => e.route);
    expect(
      missing,
      `add a SURFACES entry here for: ${missing.join(", ")}`
    ).toEqual([]);
  });

  for (const { surface, entry } of REGISTERED) {
    test(`reaches ${surface.route}`, async ({ page }) => {
      test.slow(); // next start compiles each route on its first hit
      await page.goto(surface.route);
      await expect(page.getByRole("main")).toBeVisible();
      if (entry.openFirst) {
        await page.locator(entry.openFirst).click();
      }
      // WAIT FOR THE CONTENT, NOT THE CONTAINER. A snapshot taken between the
      // shell and its content examines an empty page and reports a small number
      // that looks like a small page — and a floor is exactly the assertion that
      // direction defeats.
      // The probe hovers `document.querySelector(target)` — the first match in
      // document order — so the first match is precisely the element this wait is
      // about; waiting on any other one would prove the wrong thing.
      const hoverTarget = page.locator(entry.target).first(); // first-ok: the exact element the probe will hover
      await expect(hoverTarget).toBeVisible();

      await expectHoverProbeSees(page, surface, entry);
    });
  }
});
