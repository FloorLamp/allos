// The #3262 reproduction, standalone and outside CI.
//
// #3262 confirmed that a scrim tap after a refused flick intermittently produces
// NO CLICK AT ALL, refuted the data-loss premise it was filed under, closed three
// candidates by evidence — and could not name a mechanism. Five probe rounds
// never reproduced it outside CI, including at 20x and 60x CPU throttling.
//
// This is the reproduction, and it is deterministic. It runs on a page with NO
// REACT AND NO APP in it, so nothing it measures can be blamed on ours:
//
//   Chromium suppresses the tap gesture of the FIRST touch sequence after a drag
//   whose STARTING element forbade the axis the drag travels on.
//
// The raw touch events still arrive, and so do the touch-type PointerEvents; no
// GestureTap is produced, so the renderer synthesises no mousedown, no mouseup
// and no click. Nothing in the page can see it happen.
//
// Run it:  node scripts/tap-suppression-probe.mjs
// It needs a Chromium (PLAYWRIGHT_BROWSERS_PATH, or `npx playwright install
// chromium`) and takes about a minute. Every number quoted in
// docs/internals/e2e-hygiene.md (failure class 19) and docs/internals/overlays.md
// comes from here, so those claims stay checkable rather than remembered.
//
// It is a MEASUREMENT, not a test: it prints a table and never fails a build. A
// spec asserting that a browser bug is still present would go red the day
// Chromium fixes it, which is the day the workaround should be deleted, not the
// day CI should break. `e2e/dialog-convergence.mobile.spec.ts` holds the
// regression test — it asserts the tap LANDS, which is true either way.

import { chromium } from "playwright-core";
import fs from "node:fs";

const PAGE = `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  html, body { margin: 0; height: 100%; }
  #page { height: 2000px; }
  .host { position: fixed; inset: 0; display: flex; justify-content: center; align-items: flex-end; }
  .scrim { position: absolute; inset: 0; background: rgba(15,23,42,.4); }
  .panel { position: relative; width: 100%; background: #fff; padding: 8px 16px 24px; }
  /* The shape components/overlay/tokens.ts ships: a 40x6 bar inside a 64x24 hit
     target, and the hit target is the element that owns the axis. */
  .handle { margin: 0 auto; display: flex; height: 24px; width: 64px; align-items: center; justify-content: center; }
  .bar { height: 6px; width: 40px; border-radius: 999px; background: #cbd5e1; }
</style>
<div id="page">the page behind</div>
<div class="host">
  <div class="scrim" id="scrim"></div>
  <div class="panel"><div class="handle" id="handle"><div class="bar"></div></div><p>a sheet</p></div>
</div>
<script>
  window.__clicks = [];
  document.addEventListener("click", () => window.__clicks.push(1), { capture: true });
</script>`;

function chromiumPath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base || !fs.existsSync(base)) return undefined;
  const dir = fs
    .readdirSync(base)
    .filter((d) => d.startsWith("chromium-"))
    .sort()
    .at(-1);
  if (!dir) return undefined;
  const exe = `${base}/${dir}/chrome-linux/chrome`;
  return fs.existsSync(exe) ? exe : undefined;
}

const ITER = Number(process.env.PROBE_ITER ?? 8);
const executablePath = chromiumPath();
const browser = await chromium.launch(executablePath ? { executablePath } : {});
// The suite's phone project: 390x844, hasTouch.
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  hasTouch: true,
});
const page = await context.newPage();

/**
 * One trial: set the handle's touch-action, drag DOWN from it, optionally spend
 * the suppressed sequence the way e2e/helpers.ts does, then tap the scrim near
 * the top of the screen. Answers: did the browser make a click?
 */
async function trial({ touchAction, spend, gapMs }) {
  await page.setContent(PAGE);
  await page.evaluate(
    (ta) => (document.getElementById("handle").style.touchAction = ta),
    touchAction
  );
  const box = await page.locator("#handle").boundingBox();
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  // A separate CDP session, exactly as touchSwipeFrom uses — #3262 eliminated
  // the two-session ordering as a cause, and this keeps the shapes identical.
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: from.x, y: from.y }],
    });
    for (let step = 1; step <= 10; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: from.x, y: from.y + 26 * step }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    if (spend) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: from.x, y: from.y }],
      });
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchCancel",
        touchPoints: [],
      });
    }
  } finally {
    await cdp.detach();
  }
  if (gapMs) await page.waitForTimeout(gapMs);
  await page.evaluate(() => (window.__clicks.length = 0));
  await page.touchscreen.tap(195, 60);
  // Counted, not clocked: 40 turns of 50ms is two seconds, far longer than any
  // dispatch delay a browser applies to a tap, so an empty log means "no click
  // ever" rather than "no click yet".
  return page.evaluate(async () => {
    for (let turn = 0; turn < 40; turn++) {
      if (window.__clicks.length) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return window.__clicks.length > 0;
  });
}

async function count(options) {
  let lost = 0;
  for (let i = 0; i < ITER; i++) if (!(await trial(options))) lost++;
  return `${lost}/${ITER}`;
}

console.log(`#3262 — taps lost after a drag (${ITER} trials each)\n`);

console.log("A. touch-action on the element the DRAG STARTS ON");
for (const touchAction of ["none", "pan-x", "pan-y", "manipulation", "auto"]) {
  const lost = await count({ touchAction, spend: false, gapMs: 0 });
  console.log(`   ${touchAction.padEnd(14)} ${lost} lost`);
}
console.log(
  "   -> only the values that FORBID the drag's axis suppress the next tap.\n"
);

console.log("B. how long the suppression lasts (touch-action: none)");
for (const gapMs of [0, 100, 200, 300, 400, 600]) {
  const lost = await count({ touchAction: "none", spend: false, gapMs });
  console.log(`   gap ${String(gapMs).padStart(3)}ms  ${lost} lost`);
}
console.log(
  "   -> roughly 300ms, and it is one sequence: the next tap lands.\n"
);

console.log("C. spending the sequence (what e2e/helpers.ts does)");
for (const spend of [false, true]) {
  const lost = await count({ touchAction: "none", spend, gapMs: 0 });
  console.log(`   consumeSuppressedTap ${spend ? "on " : "off"}  ${lost} lost`);
}

await browser.close();
