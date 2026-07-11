import { test, expect } from "@playwright/test";
import { unmappedCodeIssueUrl } from "../lib/import-report";

// Import detail — Dropped grouping + scroll cap, and the "Report unmapped code"
// action (issue #270). The e2e seed (e2e/seed-events.ts) plants document 907 with
// a stored import_report: 220 identical null-flavored "Comment(s)" drops (must
// collapse to ONE ×220 row), 40 distinct value-less labs (so the collapsed list
// still overflows the card's viewport bound), and one unmapped LOINC
// (11111-1 / E2E Novel Marker / ng/mL) driving the report-link prefill.
test.describe("Import detail: dropped grouping + unmapped-code report", () => {
  test("collapses duplicate drops with ×N counts inside a scroll-capped card", async ({
    page,
  }) => {
    await page.goto("/import/907");

    const card = page.getByTestId("dropped-card");
    // The header count is the RAW drop total — collapsing changes rendering,
    // not accounting.
    await expect(card.getByText("Dropped (260)")).toBeVisible();

    // 220 identical + 40 distinct rows render as 41 collapsed rows, with the
    // duplicates folded into a single ×220 row that keeps its section chip.
    await expect(card.getByTestId("drop-row")).toHaveCount(41);
    const dupRow = card
      .getByTestId("drop-row")
      .filter({ hasText: "Comment(s)" });
    await expect(dupRow).toHaveCount(1);
    await expect(dupRow.getByTestId("drop-row-count")).toHaveText("×220");
    await expect(dupRow.getByText("Results")).toBeVisible();

    // Scroll containment: the card body is viewport-bounded and scrolls
    // internally — even 41 collapsed rows must not dominate the page.
    const scroller = card.getByTestId("dropped-scroll");
    const box = await scroller.evaluate((el) => ({
      overflowY: getComputedStyle(el).overflowY,
      maxHeight: getComputedStyle(el).maxHeight,
      scrolls: el.scrollHeight > el.clientHeight,
    }));
    expect(box.overflowY).toBe("auto");
    expect(box.maxHeight).not.toBe("none");
    expect(box.scrolls).toBe(true);
  });

  test("lists an ignored section under 'Recognized, not imported', apart from real gaps (#268)", async ({
    page,
  }) => {
    await page.goto("/import/907");

    // The seeded report marks Insurance recognized-but-ignored and leaves a
    // genuinely unrecognized "E2E Mystery Section" as a real gap — the two must
    // render in separate coverage groups.
    const ignored = page.getByTestId("coverage-ignored");
    await expect(ignored.getByText("Recognized, not imported")).toBeVisible();
    await expect(ignored.getByText("Insurance")).toBeVisible();
    await expect(ignored.getByText("intentionally out of scope")).toBeVisible();
    await expect(ignored.getByText("E2E Mystery Section")).toHaveCount(0);

    const gaps = page.getByTestId("coverage-not-consumed");
    await expect(gaps.getByText("E2E Mystery Section")).toBeVisible();
    await expect(gaps.getByText("Insurance")).toHaveCount(0);
  });

  test("offers a code/name/unit-only GitHub report link for unmapped lab codes", async ({
    page,
  }) => {
    await page.goto("/import/907");

    const card = page.getByTestId("unmapped-loincs-card");
    await expect(card.getByText("Unmapped lab codes (1)")).toBeVisible();
    // The copy makes the two contracts explicit: the records ARE imported (this
    // is about canonical trending, not data loss), and the link opens a PUBLIC
    // GitHub issue.
    await expect(card.getByText("are imported")).toBeVisible();
    await expect(card.getByText("public GitHub issue")).toBeVisible();

    const link = card.getByTestId("report-unmapped-code");
    await expect(link).toHaveCount(1);
    const href = (await link.getAttribute("href"))!;

    // The href is EXACTLY the pure helper's prefill for the seeded code — a
    // GitHub new-issue URL over title+body only.
    expect(href).toBe(
      unmappedCodeIssueUrl({
        loinc: "11111-1",
        name: "E2E Novel Marker",
        unit: "ng/mL",
      })
    );
    const url = new URL(href);
    expect(url.origin + url.pathname).toBe(
      "https://github.com/FloorLamp/allos/issues/new"
    );
    expect([...url.searchParams.keys()].sort()).toEqual(["body", "title"]);
    // PHI guard: the prefill carries the code, name, and unit — and nothing
    // that could identify the user or their readings.
    const body = url.searchParams.get("body")!;
    expect(body).toContain("11111-1");
    expect(body).toContain("E2E Novel Marker");
    expect(body).toContain("ng/mL");
    expect(body).not.toMatch(/patient|provider|\b20\d\d-\d\d-\d\d\b/i);
  });
});
