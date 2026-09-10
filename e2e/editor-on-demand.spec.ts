import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { awaitHydrated } from "./helpers";
import { showLogRow } from "./log-sheet-helpers";

// THE CLOSED EDITOR COSTS NOTHING (#5206), and this is where that is measured.
//
// `ActivityEditorProvider` is mounted by the app shell on every authenticated
// route. It used to import `ActivityOverlay` statically, which imports
// `ActivityForm` and the whole of `components/activity-form/*` — so the heaviest
// client code in the app was downloaded, parsed and hydrated on every dashboard
// visit whether or not anybody opened the editor. The provider now loads that
// code as its own chunk.
//
// WHAT "ABSENT FROM THE INITIAL REQUESTS" MEANS HERE, and why it is read off the
// SERVER-RENDERED HTML rather than off the browser's resource timeline. The
// provider WARMS the chunk as soon as it mounts, so by the time a person can tap
// anything the code is already in the browser — that is the point, and it is what
// keeps an offline open working. A timeline snapshot would therefore be racing the
// warm and would answer a different question every run. The HTML's own script set
// is the honest, timing-free statement of what a page load COSTS before it is
// interactive: those are the chunks the browser must have to hydrate.
//
// THE POSITIVE CONTROL matters more than usual here, because the absence half of
// this test would pass just as well if somebody renamed the two literals it looks
// for. So the editor's code has to be found in a chunk that is NOT one of the
// HTML's — the split proved from both sides.
//
// It also PRINTS its measurements (initial JS count/bytes, first-open latency), so
// a later lane can re-take the budget the same way rather than inheriting a number:
//   E2E_FORCE_BUILD=1 npx playwright test e2e/editor-on-demand.spec.ts --retries=0

// Two literals that exist only inside the editor's own code: the exercise name
// field's placeholder (components/activity-form/ActivityPartsList.tsx) and the
// form root's test id (components/ActivityForm.tsx).
const EDITOR_MARKERS = ["What did you do", "activity-form"] as const;

/** The `/_next/static/**.js` URLs the server-rendered HTML itself pulls in. */
function scriptUrlsIn(html: string): string[] {
  const urls = new Set<string>();
  for (const m of html.matchAll(/["'](\/_next\/static\/[^"']+?\.js)["']/g))
    urls.add(m[1]);
  return [...urls];
}

/** Does this chunk carry the editor's code? */
function holdsEditor(source: string): boolean {
  return EDITOR_MARKERS.some((marker) => source.includes(marker));
}

async function chunkSizes(
  page: Page,
  urls: string[]
): Promise<{ bytes: number; withEditor: string[] }> {
  let bytes = 0;
  const withEditor: string[] = [];
  for (const url of urls) {
    const body = await (await page.request.get(url)).text();
    bytes += Buffer.byteLength(body);
    if (holdsEditor(body))
      withEditor.push(`${url} (${Buffer.byteLength(body)} bytes)`);
  }
  return { bytes, withEditor };
}

test("the closed activity editor is not in the dashboard's initial JavaScript (#5206)", async ({
  page,
}) => {
  await page.goto("/");
  const trigger = page.locator("aside").getByTestId("sidebar-log");
  await awaitHydrated(trigger);

  // The shell's own cost: the scripts the dashboard's HTML asks for.
  const html = await (await page.request.get("/")).text();
  const initialUrls = scriptUrlsIn(html);
  expect(initialUrls.length).toBeGreaterThan(0);
  const initial = await chunkSizes(page, initialUrls);
  const nav = await page.evaluate(() => {
    const entry = performance.getEntriesByType(
      "navigation"
    )[0] as PerformanceNavigationTiming;
    return {
      ttfb: Math.round(entry.responseStart - entry.requestStart),
      dcl: Math.round(entry.domContentLoadedEventEnd - entry.startTime),
    };
  });
  console.log(
    `[#5206] dashboard initial JS: ${initialUrls.length} chunks, ${initial.bytes} bytes; ` +
      `TTFB ${nav.ttfb} ms, DCL ${nav.dcl} ms`
  );

  expect(
    initial.withEditor,
    "the closed editor's code is in the dashboard's initial JavaScript"
  ).toEqual([]);

  // First open, from the desktop sidebar's "+ Log" panel — the flow the issue's
  // baseline timed. The click and the visible field are one interaction, so the
  // elapsed time is what a person waits for.
  await trigger.click();
  const row = await showLogRow(
    page.getByTestId("sidebar-log-panel"),
    "log-activity"
  );
  const startedAt = Date.now(); // eslint-disable-line no-restricted-properties -- clock-ok: measures this spec's own elapsed wall time, never a stored instant
  await row.click();
  const form = page.getByTestId("activity-form");
  await expect(form).toBeVisible();
  console.log(
    `[#5206] first open (click -> form visible): ${Date.now() - startedAt} ms` // eslint-disable-line no-restricted-properties -- clock-ok: elapsed wall time for the measurement above
  );

  // THE POSITIVE CONTROL. The editor's code did arrive — in a chunk the initial
  // HTML never asked for. Without this, renaming either marker would turn the
  // absence assertion above into a test that cannot fail.
  const loaded = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .filter((name) => name.includes("/_next/static/") && name.includes(".js"))
  );
  const extra = loaded
    .map((name) => new URL(name).pathname)
    .filter((path) => !initialUrls.includes(path));
  const editorChunks = (await chunkSizes(page, extra)).withEditor;
  expect(
    editorChunks.length,
    "the editor's code was not found in any chunk outside the initial set"
  ).toBeGreaterThan(0);
  console.log(
    `[#5206] editor chunks loaded on demand: ${editorChunks.join(", ")}`
  );
});
