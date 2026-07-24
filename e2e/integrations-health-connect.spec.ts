import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_HC, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// /integrations/health-connect (issue #391, gap 4; hash-at-rest reveal-once #1209).
// The push-based ingest token is managed here (generate → rotate → disconnect). The
// token is HASHED at rest, so its plaintext is shown EXACTLY ONCE — at generate/
// rotate — and a plain reload of a connected profile shows NO token, just a Rotate
// button. This drives an isolated member on a dedicated, connection-less fixture
// profile — so it never connects profile 1's Health Connect, whose UNconnected state
// the review-inbox spec relies on — and proves that rotating mints a new value.

// Reveal the (single, secret) Bearer-token field just shown by a generate/rotate and
// read its value. The field carries a dedicated testid (health-connect-token), so it's
// unambiguous even though the page also renders font-mono <code> cells in the
// recommended-settings table. A rotate re-renders the field masked, so reveal again.
async function readRevealedToken(page: Page): Promise<string> {
  const reveal = page.getByRole("button", { name: "Reveal" });
  if (await reveal.count()) await reveal.first().click(); // first-ok: reveals the just-minted token (guarded by count; this integration has one token) — order-agnostic
  const text = await page.getByTestId("health-connect-token").textContent();
  return (text ?? "").trim();
}

test.describe("Health Connect integration (#391)", () => {
  test("token is shown once at generate/rotate and rotating mints a fresh value", async ({
    browser,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_HC,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/health-connect");
      const main = member.getByRole("main");
      await expect(
        main.getByRole("heading", {
          name: "Google Health Connect",
          exact: true,
        })
      ).toBeVisible();

      // Enable it if this profile isn't already connected (retry-safe against a
      // reused DB): the generate button only shows in the disconnected state.
      const generate = member.getByTestId("health-connect-generate");
      if (await generate.count()) {
        await generate.click();
      }

      // Connected: a status badge renders. Reveal-once means a plain connected view
      // may show no token — so ROTATE to get a freshly-revealed one (retry-safe: a
      // rotate always mints + reveals a value regardless of prior state).
      await expect(member.getByTestId("health-connect-status")).toBeVisible();
      const tokenField = member.getByTestId("health-connect-token");

      await member.getByTestId("health-connect-rotate").click();
      // Wait for the reveal-once token field to appear, then read it.
      await expect(tokenField).toBeVisible({ timeout: 15_000 });
      const first = await readRevealedToken(member);
      expect(first.length).toBeGreaterThan(10);

      // #1212: sync history is deduped to ONE surface (Review → Connected
      // sources). The setup page no longer renders its own "Recent activity"
      // table — it links to that single history instead (a real destination, not
      // a dead-end).
      const historyLink = member.getByTestId("sync-history-link");
      await expect(historyLink).toBeVisible();
      await expect(historyLink).toHaveAttribute("href", "/data?section=review");
      await expect(member.getByText("Recent activity")).toHaveCount(0);

      // Rotate again → a fresh token replaces the revealed one. The displayed value
      // updates from the action's return (no RSC roundtrip), so wait for it to swap
      // away from the previous token, then reveal + read the new one. Reveal first so
      // the field shows the plaintext (not the mask) before comparing.
      await member.getByTestId("health-connect-rotate").click();
      const revealBtn = member.getByRole("button", { name: "Reveal" });
      if (await revealBtn.count()) await revealBtn.first().click(); // first-ok: reveals the single token field — order-agnostic
      await expect(tokenField).not.toHaveText(first, { timeout: 15_000 });
      const second = await readRevealedToken(member);
      expect(second.length).toBeGreaterThan(10);
      expect(second).not.toBe(first);

      // Reveal-once: on a fresh reload the token field is gone entirely (only the
      // endpoint URL remains); the panel points the user at Rotate instead.
      await member.goto("/integrations/health-connect");
      await expect(member.getByTestId("health-connect-status")).toBeVisible();
      await expect(
        member.getByText("only shown at the moment it", { exact: false })
      ).toBeVisible();
      await expect(member.getByTestId("health-connect-token")).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });

  // Issue #1065: the setup card renders the per-type "Recommended settings" matrix
  // (SOURCE_FIDELITY), so the user knows which granularity to pick in the exporter app.
  test("renders the recommended per-type granularity settings block", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_HC,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/health-connect");
      const block = member.getByTestId("hc-recommended-settings");
      await expect(block).toBeVisible();
      await expect(
        block.getByRole("heading", { name: "Recommended settings" })
      ).toBeVisible();
      // A load-bearing row from the verified matrix: Heart rate → 1m.
      await expect(
        block.getByText("Heart rate", { exact: true })
      ).toBeVisible();
      await expect(block.getByText("1m", { exact: true })).toBeVisible();
    } finally {
      await member.context().close();
    }
  });
});
