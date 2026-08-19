import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { expectNoClippedContent, settledClick } from "./helpers";

// #2940 — the Today check-off row must stay identifiable when its dose detail is
// long. The detail span used to be `shrink-0` while the name was the only shrinkable
// element, so a 90-character amount claimed its full intrinsic width, crushed the
// name to ZERO characters, and spilled its overflow under the row's controls. Four
// of a child's six as-needed rows rendered nameless on the observed page, each with
// a live Log control beside it.
//
// The assertions are geometric because the defect is: a row whose name is present in
// the DOM but rendered at 0px reads as absent, and no text assertion can see that.
//
// Fixture (#868 hygiene): SPEC-OWNED. The long-detail medication is created here, by
// this spec, under a name unique to the repeat index, so a `--repeat-each` run does
// not accumulate rows and no seeded fixture is perturbed.

const LONG_DETAIL =
  "Take 1.5 mL (1.25 mg) by nebulization every 6 hours if needed for wheezing";

// Every Today row on the page whose NAME is not rendered in full. The name is the
// element with priority, so on this surface "shown at all" is not the bar — it either
// fits (and is whole) or the cell is too narrow for the name alone. Rows inside a
// collapsed section are laid out at zero and prove nothing; they are skipped.
async function truncatedNames(page: Page): Promise<string[]> {
  return page.locator('[data-today-row="1"]').evaluateAll((rows) =>
    rows.flatMap((row) => {
      const name = row.querySelector('[data-testid="today-med-name"]');
      if (!name || row.getBoundingClientRect().width === 0) return [];
      const width = name.getBoundingClientRect().width;
      // `scrollWidth` is the untruncated text width.
      if (width >= name.scrollWidth - 1) return [];
      return [
        `${name.textContent?.trim()} rendered at ${Math.round(width)}px of ${name.scrollWidth}px`,
      ];
    })
  );
}

// Every Today row whose detail escapes the left cell and renders across the controls
// column — the "…d for w" fragment beside the Log button.
async function detailsPastControls(page: Page): Promise<string[]> {
  return page.locator('[data-today-row="1"]').evaluateAll((rows) =>
    rows.flatMap((row) => {
      const detail = row.querySelector('[data-testid="today-med-detail"]');
      const cells = Array.from(
        row.querySelector(":scope > div")?.children ?? []
      );
      // One cell means the row has no controls beside the identity pair.
      if (
        !detail ||
        cells.length < 2 ||
        row.getBoundingClientRect().width === 0
      )
        return [];
      const controls = cells[cells.length - 1];
      const overhang =
        detail.getBoundingClientRect().right -
        controls.getBoundingClientRect().left;
      if (overhang <= 1) return [];
      return [
        `${detail.textContent?.trim().slice(0, 40)}… overhangs the controls by ${Math.round(overhang)}px`,
      ];
    })
  );
}

test("a long dose detail never costs the medication its name (#2940)", async ({
  page,
}, testInfo) => {
  const medName = `Long Detail Med ${testInfo.repeatEachIndex} (e2e)`;

  await page.goto("/medications");
  await page.getByTestId("medication-add-toggle").click();
  await page.getByTestId("medication-add-full").click();
  const addCard = page.getByTestId("medication-add-panel");
  await expect(addCard).toBeVisible();

  // Free text in both comboboxes: the name is this spec's own, and the amount is the
  // 73-character sig sentence a real import produced (#2939).
  const nameInput = addCard.getByRole("combobox", { name: "Name" });
  await nameInput.fill(medName);
  // Escape closes the suggestion listbox only (it is not a modal), so the controls
  // it overlaps are clickable again.
  await nameInput.press("Escape");
  await addCard.getByTestId("med-obligation").selectOption("may");
  const doseRow = addCard.getByTestId("prn-dose-row");
  await expect(doseRow).toBeVisible();
  const amountInput = doseRow.getByRole("combobox", { name: "Amount" });
  await amountInput.fill(LONG_DETAIL);
  await amountInput.press("Escape");

  await settledClick(
    page,
    addCard.getByRole("button", { name: "Add", exact: true })
  );

  // The row is on the Today panel, and it is IDENTIFIABLE: the name renders, the
  // detail is the element that gives up its width.
  const row = page
    .locator('[data-testid="quick-log-prn-item"][data-today-row="1"]')
    .filter({ hasText: medName });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("today-med-name")).toHaveText(medName);

  const [nameWidth, detailClipped] = await row.evaluate((node) => {
    const name = node.querySelector('[data-testid="today-med-name"]')!;
    const detail = node.querySelector('[data-testid="today-med-detail"]')!;
    return [
      name.getBoundingClientRect().width,
      detail.scrollWidth > Math.ceil(detail.getBoundingClientRect().width),
    ] as [number, boolean];
  });
  expect(nameWidth).toBeGreaterThan(0);
  expect(detailClipped).toBe(true); // the detail truncates; it does not push

  // And the whole panel holds: every row's name renders in full, no detail crosses
  // into the controls column, nothing on the page sits past the viewport edge.
  const truncated = await truncatedNames(page);
  expect(truncated, truncated.join("\n")).toEqual([]);
  const past = await detailsPastControls(page);
  expect(past, past.join("\n")).toEqual([]);
  await expectNoClippedContent(page);
});

// Both row BRANCHES: the medications page links the name to the med detail page, the
// dashboard's PRN atom renders the same pair unlinked. Both VARIANTS (inset,
// embedded) render on those two surfaces. The claim here is that nothing was paid for
// the fix: a pair that FITS its cell is still rendered whole, name and detail alike —
// which is the "identical to today" half of the change.
test("a pair that fits is rendered whole, in both row branches (#2940)", async ({
  page,
}) => {
  for (const path of ["/medications", "/"] as const) {
    await page.goto(path);
    const rows = page.locator('[data-today-row="1"]');
    if ((await rows.count()) === 0) continue;
    const truncated = await truncatedNames(page);
    expect(truncated, `${path}\n${truncated.join("\n")}`).toEqual([]);
    const past = await detailsPastControls(page);
    expect(past, `${path}\n${past.join("\n")}`).toEqual([]);

    const clipped = await rows.evaluateAll((nodes) =>
      nodes.flatMap((node) => {
        const name = node.querySelector('[data-testid="today-med-name"]');
        const detail = node.querySelector('[data-testid="today-med-detail"]');
        if (!name || !detail || node.getBoundingClientRect().width === 0)
          return [];
        // In scope only when the untruncated pair fits the line that holds it —
        // the gap between them is 0.25rem.
        const line = name.parentElement!.getBoundingClientRect().width;
        if (name.scrollWidth + detail.scrollWidth + 4 > line) return [];
        const width = detail.getBoundingClientRect().width;
        return width >= detail.scrollWidth - 1
          ? []
          : [
              `${detail.textContent?.trim()} clipped at ${Math.round(width)}px of ${detail.scrollWidth}px`,
            ];
      })
    );
    expect(clipped, `${path}\n${clipped.join("\n")}`).toEqual([]);
  }
});
