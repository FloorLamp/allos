import { test, expect } from "@playwright/test";
import { loginAs, openCommandPalette } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_LOGIN_ASK,
  E2E_MEMBER_PASSWORD,
  ASK_RECORDS_MED,
} from "./fixture-logins";

// Grounded record Q&A — "ask your records" (issue #878, Phase 2) — the surface proof.
// Reuses the isolated ASK_RECORDS fixture (an antibiotics medication + a matching
// urgent-care visit). The e2e DB boots WITHOUT an AI tier, so the palette's "Ask about
// your records" returns the OFFLINE structured answer — the deterministically retrieved,
// profile-scoped rows, each rendered as a LINKED citation (grounded means grounded). The
// empty-retrieval "nothing found" refusal is exercised over an unmatched question. Read-
// only + isolated fixture, so it's safe under --repeat-each.
test.describe("ask your records (#878)", () => {
  test("asking a question retrieves the profile's own rows as a linked answer (offline)", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_ASK,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/");
    const input = await openCommandPalette(page);
    await input.fill("when did I last take antibiotics?");

    // The Ask affordance appears on a non-empty query.
    const trigger = page.getByTestId("ask-records-trigger");
    await expect(trigger).toBeVisible();
    // Clicking fires the grounded Q&A server action; await it before asserting.
    await settledClick(page, trigger);

    // Keyless → the offline structured answer, built from the deterministically
    // retrieved rows. The panel renders, and at least one citation LINKS the found
    // antibiotics medication — a real, navigable record (grounding is literal).
    const panel = page.getByTestId("ask-records-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("ask-records-answer")).toBeVisible();
    const citation = panel
      .getByTestId("ask-records-citation")
      .filter({ hasText: ASK_RECORDS_MED });
    await expect(citation.first()).toBeVisible(); // first-ok: the med citation in this spec's own isolated fixture — order-agnostic
  });

  test("an unmatched question refuses with 'nothing found', never speculates", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_ASK,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/");
    const input = await openCommandPalette(page);
    await input.fill("chemotherapy radiation dialysis?");

    await settledClick(page, page.getByTestId("ask-records-trigger"));

    // The deterministic refusal: no matching record ⇒ "nothing found", and no
    // citation links (never a speculation).
    const panel = page.getByTestId("ask-records-panel");
    await expect(panel).toBeVisible();
    await expect(page.getByTestId("ask-records-answer")).toContainText(
      /nothing found in your records/i
    );
    await expect(panel.getByTestId("ask-records-citation")).toHaveCount(0);
  });
});
