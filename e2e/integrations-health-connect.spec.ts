import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledCheckSave } from "./helpers";
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

      // #1212 deduped sync history to ONE surface and left this page a link to it;
      // #1772 inverted that — the source's own page is its HOME, so the history
      // renders here as a real table and Review became an inbox linking back.
      await expect(member.getByTestId("sync-history-link")).toHaveCount(0);
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
      // #3490 item 2 compressed the five-line show-once paragraph to one line, and
      // moved the rotate consequence next to the Rotate button it describes.
      await expect(member.getByTestId("health-connect-token-note")).toHaveText(
        "The token is shown only when it’s created."
      );
      await expect(member.getByTestId("health-connect-rotate-note")).toHaveText(
        "Replaces the old one — update your phone exporter."
      );
      // #3490 item 3: the facts list no longer restates an expiry the EXPIRY
      // select below it already carries.
      await expect(member.getByTestId("token-expiry")).toHaveCount(0);
      await expect(member.getByTestId("token-expiry-select")).toBeVisible();
      await expect(member.getByTestId("health-connect-token")).toHaveCount(0);

      // The sync history table lives here now (#1772). This fixture profile has no
      // sync events of its own, so it states that plainly rather than linking away.
      const history = member.getByTestId("sync-history");
      await expect(history).toBeVisible();
      await expect(history).toContainText("No syncs recorded yet");
      // The token card answers a DIFFERENT question (is the credential alive) and
      // keeps its own lifecycle badge; the sync standing is the shared one.
      await expect(
        member.getByTestId("sync-status-health-connect")
      ).toBeVisible();
    } finally {
      await member.context().close();
    }
  });

  // Issue #3182: the ONE glucose switch. Off by default and nothing asks at setup —
  // a fingerstick meter and a CGM push the same Health Connect record type, so the
  // safe answer for someone who has not thought about it keeps a discrete reading a
  // discrete reading. Flipping it persists across a reload.
  test("the continuous-sensor glucose switch is off by default and persists", async ({
    browser,
  }) => {
    test.slow();
    const member = await loginAs(browser, {
      username: E2E_LOGIN_HC,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/health-connect");
      const generate = member.getByTestId("health-connect-generate");
      if (await generate.count()) await generate.click();
      await expect(member.getByTestId("health-connect-status")).toBeVisible();

      const card = member.getByTestId("hc-cgm-glucose");
      const toggle = member.getByTestId("hc-cgm-glucose-toggle");
      await expect(toggle).not.toBeChecked();
      // The reload must reach a SETTLED page rather than race one (#4972). The box
      // paints the new value in the same frame, so it is not evidence the write
      // landed; the card's autosave spinner is, and a reload issued while it is up
      // CANCELS the write — which is how this spec's restore step went red on main.
      // settledCheckSave waits on that spinner: a rendered state, not a sleep.
      await settledCheckSave(member, toggle, true, card);
      await expect(toggle).toBeChecked();

      await member.reload();
      await expect(toggle).toBeChecked();

      // Leave the fixture profile as it was found — this spec shares its member with
      // the token test above, and a latched switch is state the next run inherits.
      await settledCheckSave(member, toggle, false, card);
      await member.reload();
      await expect(toggle).not.toBeChecked();
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
