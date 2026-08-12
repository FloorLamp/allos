import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_ROUTINEUSUAL, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// THE MORNING IS ONE PHYSICAL EVENT (#2458) — the composed one-tap on the dashboard.
//
// Fixture-OWNED on its own profile (E2E_LOGIN_ROUTINEUSUAL): three weeks of the same
// two groups in every food window, today empty, plus three `should` supplements with a
// dose row per window and one `may` supplement that must never appear. The spec WRITES
// (it taps the offer, logging two servings and confirming three doses), so it owns its
// fixture and puts every row back at the end — which doubles as the assertion that the
// control renders from STATE in both directions.

test("the dashboard offers the whole morning in one tap, and collapses once it is logged (#2458)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_ROUTINEUSUAL,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    test.slow();
    await page.goto("/");

    // The control names EVERY write it will perform — both halves, with the seam
    // between servings and dose confirms visible. The label IS the promise.
    const offer = page.getByTestId("routine-usual-offer");
    await expect(offer).toBeVisible();
    await expect(offer).toHaveAttribute("data-groups", "berries,fermented");
    await expect(page.getByTestId("routine-usual-names")).toHaveText(
      "Berries and Fermented foods + Creatine, Collagen and B-complex"
    );
    // The `may` supplement is declared for this window too and is absent — it has no
    // dueness, which is the predicate the exclusion rides (#2419).
    await expect(page.getByTestId("routine-usual-names")).not.toContainText(
      "Magnesium"
    );

    // One tap writes all five.
    await settledClick(page, offer);
    // …and the control is GONE, because it is rendered from state: the window now
    // holds its usual set, so there is nothing left a second tap could log.
    await expect(offer).toHaveCount(0);

    // The absence survives a reload — it is the server's answer, not a local flag.
    await page.reload();
    await expect(page.getByTestId("routine-usual-offer")).toHaveCount(0);

    // Both halves really landed. The servings:
    await page.goto("/nutrition");
    await expect(page.getByTestId("count-berries")).toHaveText("1");
    await expect(page.getByTestId("count-fermented")).toHaveText("1");

    // …and the doses, each now confirmed on its own row.
    await page.goto("/nutrition?tab=supplements");
    const taken = page.getByRole("button", { name: "Mark not taken" });
    await expect(taken).toHaveCount(3);

    // Teardown through the product's own controls, which is also the both-directions
    // assertion: undo what made the control disappear and it comes back.
    for (let i = 0; i < 3; i++) {
      await settledClick(page, taken.first()); // first-ok: the three confirmed rows are interchangeable here — each pass clears one and the count is asserted after the loop
    }
    await expect(taken).toHaveCount(0);
    await page.goto("/nutrition");
    await settledClick(page, page.getByTestId("undo-berries"));
    await expect(page.getByTestId("count-berries")).toHaveText("0");
    await settledClick(page, page.getByTestId("undo-fermented"));
    await expect(page.getByTestId("count-fermented")).toHaveText("0");

    await page.goto("/");
    await expect(page.getByTestId("routine-usual-offer")).toBeVisible();
    await expect(page.getByTestId("routine-usual-names")).toHaveText(
      "Berries and Fermented foods + Creatine, Collagen and B-complex"
    );
  } finally {
    await page.context().close();
  }
});
