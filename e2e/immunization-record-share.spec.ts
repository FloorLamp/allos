import { test, expect } from "./fixtures";
import { CONTROL_BOX_PX } from "@/lib/tap-floor-tokens";
import type { Page } from "@playwright/test";
import { expectNoClippedContent, followLink, settledBoxes } from "./helpers";

// The printable immunization record and its revocable share link (#1849). The one
// record type whose stated purpose is being handed to a registrar had neither, while
// the medication list had both. This drives the whole loop on the seeded profile
// (scripts/seed.ts gives profile 1 an MMR, a 2018-09-01 Tdap booster and an
// influenza dose): print view → tokenized share → anonymous render → revoke.

// Open the pane's ⋯ (#3408, item C). Visibility-guarded rather than a bare click,
// for the #730/#500 reason the share-modal loop below already records: the ⋯ is a
// client-state toggle with no POST and no navigation to settle on, so a tap in the
// pre-hydration window is swallowed in silence. The guard means an already-open
// menu is never clicked shut.
async function openRecordActions(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: "Record actions" });
  const printLink = page.getByTestId("immunization-print-link");
  await expect(async () => {
    if (!(await printLink.isVisible())) await trigger.click();
    await expect(printLink).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20000, intervals: [300, 700, 1500] }); // topass-ok: re-tap the ⋯ until its panel appears past the hydration swallow — visibility-guarded so a late tap cannot close it
}

test.describe("Immunization record print + share (#1849)", () => {
  test("prints the grouped record and shares the same content by token", async ({
    page,
    browser,
  }) => {
    // Local `next dev` compiles /immunizations/print + /share on first hit.
    test.slow();
    await page.goto("/records/history/immunizations");
    // PRINT AND SHARE FOLD BEHIND THE PANE'S ⋯ (#3408, item C): one primary per
    // pane, and print/share/import are rare-cadence. Both keep their testids,
    // their accessible names and their behaviour — reaching them is one extra
    // tap. Below `md` this same ⋯ is an action sheet (#3374); this spec runs at
    // desktop width, where it is the anchored popover.
    await openRecordActions(page);
    const printLink = page.getByTestId("immunization-print-link");
    await expect(printLink).toBeVisible();

    // Navigate past the pre-hydration swallow (#730/#500) with the blessed helper.
    await followLink(page, printLink, /\/immunizations\/print/);
    const print = page.getByTestId("immunization-print");
    await expect(print).toBeVisible();
    const record = print.getByTestId("immunization-record-view");
    // The seeded Tdap booster, grouped under its vaccine with its date.
    const tdap = record.locator(
      '[data-testid="immunization-record-group"][data-vaccine="tdap"]'
    );
    await expect(tdap).toContainText("Tdap");
    await expect(tdap.getByTestId("immunization-record-dose")).toHaveCount(1);
    // Transcription columns a school / camp / employer form asks for.
    await expect(record).toContainText("Lot");
    await expect(record).toContainText("Route");
    await expect(record).toContainText("Administered by");

    // Mint the share link from the immunizations surface.
    await page.goto("/records/history/immunizations");
    const create = page.getByTestId("immunization-share-create");
    // Ride out the hydration window (#730): retry opening the modal until its
    // Create button (a client-state toggle) actually appears.
    await expect(async () => {
      await openRecordActions(page);
      await page.getByTestId("immunization-share-open").click();
      await expect(create).toBeVisible({ timeout: 2000 });
    }).toPass(); // topass-ok: re-open the ⋯ and the share modal until its client-state Create button appears past the hydration swallow (#730) — no awaitable event for a client toggle
    await create.click();
    const urlField = page.getByTestId("immunization-share-url");
    await expect(urlField).toBeVisible();
    const shareUrl = await urlField.inputValue();
    expect(shareUrl).toContain("/share/");

    await page.setViewportSize({ width: 390, height: 844 });
    const result = page.getByTestId("created-share-link");
    const copy = result.getByRole("button", { name: "Copy link" });
    const [resultBox, valueBox, copyBox] = await settledBoxes([
      result,
      urlField,
      copy,
    ]);
    // The control box (#3938): the 44 is effective now and needs a coarse pointer.
    expect(Math.min(copyBox.width, copyBox.height)).toBeGreaterThanOrEqual(
      CONTROL_BOX_PX
    );
    expect(copyBox.x).toBeGreaterThanOrEqual(resultBox.x - 1);
    expect(copyBox.y).toBeGreaterThanOrEqual(resultBox.y - 1);
    expect(copyBox.x + copyBox.width).toBeLessThanOrEqual(
      resultBox.x + resultBox.width + 1
    );
    expect(copyBox.y + copyBox.height).toBeLessThanOrEqual(
      resultBox.y + resultBox.height + 1
    );
    expect(valueBox.x + valueBox.width).toBeLessThanOrEqual(copyBox.x);
    await expectNoClippedContent(page);

    // The tokenized view: no login, the SAME record component, and no way into the
    // app from it.
    const anonCtx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const anon = await anonCtx.newPage();
    const resp = await anon.goto(shareUrl);
    expect(resp?.status()).toBe(200);
    const shared = anon.getByTestId("immunization-record-view");
    await expect(shared).toBeVisible();
    await expect(
      shared.locator(
        '[data-testid="immunization-record-group"][data-vaccine="tdap"]'
      )
    ).toBeVisible();
    await expect(anon.getByRole("link", { name: "Data" })).toHaveCount(0);
    await expect(anon.getByTestId("profile-identity-bar")).toHaveCount(0);
    await anonCtx.close();

    // Revoke it from the passport's share management list, which names the link's
    // KIND so the right one can be picked out (#1849).
    await page.goto("/profile");
    await page.getByRole("button", { name: "Share" }).click();
    const row = page
      .locator("li")
      .filter({ hasText: "Immunization record" })
      .filter({ has: page.getByRole("button", { name: "Revoke" }) })
      .first(); // first-ok: newest-first list — the FIRST immunization-record row is the link THIS test just created
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Revoke" }).click();

    // The same token now 404s with the anti-probing copy.
    const anonCtx2 = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const anon2 = await anonCtx2.newPage();
    const resp2 = await anon2.goto(shareUrl);
    expect(resp2?.status()).toBe(404);
    await expect(
      anon2.getByText("This link is no longer active")
    ).toBeVisible();
    await anonCtx2.close();
  });
});
