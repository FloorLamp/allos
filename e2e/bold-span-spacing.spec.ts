import { test, expect } from "./fixtures";
// #1447 — the census found pages rendering "At minimaldetail", "A read-onlygrant",
// "…you can access.Each profile keeps…". The source was never wrong: a JSX text
// node that follows an element, begins with a space, and contains an HTML entity
// loses that leading space in the SSR output (see the full write-up in
// lib/__tests__/emphasis-spacing.test.ts).
//
// That source guard bans the trigger, but it is a PROXY: the defect is only ever
// visible in the rendered output, and the source reads correctly either way. So
// these three assertions check the actual DOM on the pages the census caught —
// cheap (one load each) and the only thing that can't be fooled by source that
// merely looks right.
//
// textContent (not innerText) is deliberate: it is the raw DOM text, so a failure
// here is a real missing character rather than a CSS/layout artifact.

test("bold spans render with the space that follows them", async ({ page }) => {
  // Settings → Server → AI (the tier cards' home since #1870): the paragraph where
  // two structurally identical lines disagreed — "Heavy handles" rendered fine
  // while "Lighthandles" did not.
  await page.goto("/settings/ai");
  const ai = page
    .locator("p")
    .filter({ hasText: "Two tiers, each its own provider" })
    .first(); // first-ok: one AI-providers blurb on the page
  const aiText = await ai.evaluate((e) => e.textContent);
  expect(aiText).toContain("Heavy handles");
  expect(aiText).toContain("Light handles");

  // /integrations/calendar-feed: "At minimaldetail each event…".
  await page.goto("/integrations/calendar-feed");
  const cf = page
    .locator("p")
    .filter({ hasText: "detail each event shows" })
    .first(); // first-ok: one detail-level blurb renders at a time
  expect(await cf.evaluate((e) => e.textContent)).toContain("minimal detail");

  // /settings/family: "A read-onlygrant can view everything".
  await page.goto("/settings/family");
  const fam = page
    .locator("p")
    .filter({ hasText: "grant can view everything" })
    .first(); // first-ok: one Access blurb on the page
  expect(await fam.evaluate((e) => e.textContent)).toContain("read-only grant");
});
