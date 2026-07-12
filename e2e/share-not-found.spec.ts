import { test, expect } from "@playwright/test";

// Issue #478: a recipient opening a revoked/expired/mistyped share link must land
// on the friendly, styled "no longer active" page — NOT Next's bare unstyled 404.
// A nonexistent token exercises the exact same notFound() path a revoked link takes
// (the share page deliberately makes them indistinguishable), so a bogus token is a
// faithful stand-in and needs no seeded link. This is an ANONYMOUS surface: no
// storageState, so the request is unauthenticated like a real recipient's.
test.use({ storageState: { cookies: [], origins: [] } });

test("revoked/invalid share link shows the friendly not-found page (#478)", async ({
  page,
}) => {
  const resp = await page.goto("/share/definitely-not-a-real-token-478");
  // Real 404 status from notFound(), not a soft 200 error page.
  expect(resp?.status()).toBe(404);
  // The styled message, not Next's default "This page could not be found."
  await expect(page.getByText("This link is no longer active")).toBeVisible();
  await expect(
    page.getByText(/ask the person who shared it to send you a new link/i)
  ).toBeVisible();
  // Anti-probing: the page never confirms whether the link ever existed.
  await expect(page.getByText(/revoked|expired/i)).toHaveCount(0);
});
