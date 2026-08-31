import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { workerDbPath } from "./worker-env";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_HXEVERY,
  HXEVERY_SELF_PROFILE,
  HXEVERY_RO_PROFILE,
} from "./fixture-logins";

// Throwaway (#4394). Sweeps N in `max-width: calc(100% - Npx)` on the subject and
// reports, at 320px, at BOTH mounts: what the title/label keeps, and whether the
// ordinary household name (94px, the one that already fits) survives whole.
const LONG_NAME =
  "Record Read Only Household Member With A Very Long Display Name 2 (e2e)";
const NS = [0, 12, 24, 32, 40, 48, 56, 60, 64, 68, 69, 72, 80, 96];

test("sweep subject floor 4394", async ({ browser }) => {
  test.slow();
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  const roId = (
    db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(HXEVERY_RO_PROFILE) as { id: number }
  ).id;
  db.prepare("UPDATE profiles SET name = ? WHERE id = ?").run(LONG_NAME, roId);
  db.close();

  const page = await loginAs(browser, {
    username: E2E_LOGIN_HXEVERY,
    password: E2E_MEMBER_PASSWORD,
  });
  await expect(page.getByTestId("profile-identity-bar")).toContainText(
    HXEVERY_SELF_PROFILE
  );
  const trigger = page.getByTestId("profile-identity-bar");
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByTestId("profile-switcher-panel")).toBeVisible();
  await settledClick(page, page.getByTestId(`view-toggle-${roId}`));
  await page.setViewportSize({ width: 320, height: 844 });

  const read = async (cap: string) =>
    page.evaluate((cap) => {
      const vw = document.documentElement.clientWidth;
      for (const el of Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="history-row-subject"]'
        )
      )) {
        el.style.maxWidth = cap;
      }
      void document.body.offsetWidth;
      const painted = (el: Element) => {
        const r = el.getBoundingClientRect();
        let lo = r.left;
        let hi = r.right;
        for (let a = el.parentElement; a; a = a.parentElement) {
          const o = getComputedStyle(a).overflowX;
          if (o === "hidden" || o === "clip") {
            const ar = a.getBoundingClientRect();
            lo = Math.max(lo, ar.left);
            hi = Math.min(hi, ar.right);
          }
        }
        return Math.round(Math.max(0, Math.min(hi, vw) - Math.max(lo, 0)) * 10) / 10;
      };
      return Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid="history-row-subject"]'
        )
      ).map((s) => {
        const t = s.previousElementSibling;
        return {
          who: (s.textContent ?? "").trim().slice(0, 20),
          computed: getComputedStyle(s).maxWidth,
          titlePainted: t ? painted(t) : null,
          subjectPainted: painted(s),
          subjectBox: Math.round(s.getBoundingClientRect().width * 10) / 10,
          subjectNatural: s.scrollWidth,
          ell: s.scrollWidth > s.clientWidth + 1,
          clusterW:
            Math.round(s.parentElement!.getBoundingClientRect().width * 10) / 10,
        };
      });
    }, cap);

  const out: unknown[] = [];
  for (const [site, url] of [
    ["row", "/history?kind=dose&view=everyone"],
    ["rollup", "/history?view=everyone"],
  ] as const) {
    await page.goto(url);
    await expect(page.getByTestId("history-row-subject").first()).toBeVisible();
    for (const n of NS) {
      out.push({ site, n, lines: await read(`calc(100% - ${n}px)`) });
    }
    out.push({ site, n: "66%", lines: await read("66%") });
  }
  const restore = new Database(workerDbPath());
  restore.pragma("busy_timeout = 5000");
  restore
    .prepare("UPDATE profiles SET name = ? WHERE id = ?")
    .run(HXEVERY_RO_PROFILE, roId);
  restore.close();
  console.log("SWEEP4394 " + JSON.stringify(out));
});
