import { test, expect } from "./fixtures";
import { type Browser, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { expectNoClippedContent, settledBoxes } from "./helpers";
import { frozenNow, workerDbPath } from "./worker-env";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_NOWSTRIP,
  E2E_LOGIN_NOWSAFETY,
  E2E_LOGIN_WHATSNEW,
} from "./fixture-logins";

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };
const DESKTOP = { viewport: { width: 1280, height: 900 }, hasTouch: false };

async function openDashboard(
  browser: Browser,
  creds: { username: string },
  contextOptions: Record<string, unknown> = PHONE
): Promise<Page> {
  const page = await loginAs(
    browser,
    { username: creds.username, password: E2E_MEMBER_PASSWORD },
    contextOptions
  );
  await page.goto("/");
  return page;
}

function insertRecentlyEndedNap(username: string): () => void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const profile = db
      .prepare(
        `SELECT lp.profile_id
           FROM logins l JOIN login_profiles lp ON lp.login_id = l.id
          WHERE l.username = ?
          ORDER BY lp.profile_id
          LIMIT 1`
      )
      .get(username) as { profile_id: number };
    const end = new Date(frozenNow().getTime() - 30 * 60_000);
    const start = new Date(end.getTime() - 30 * 60_000);
    const wakeDay = frozenNow().toISOString().slice(0, 10);
    const insert = db.prepare(
      `INSERT INTO metric_samples
         (profile_id, source, metric, date, started_at, ended_at, value)
       VALUES (?, 'manual', 'sleep_min', ?, ?, ?, ?)`
    );
    const mainEnd = new Date(frozenNow().getTime() - 6 * 60 * 60_000);
    const mainStart = new Date(mainEnd.getTime() - 8 * 60 * 60_000);
    const ids = [
      Number(
        insert.run(
          profile.profile_id,
          wakeDay,
          mainStart.toISOString(),
          mainEnd.toISOString(),
          480
        ).lastInsertRowid
      ),
      Number(
        insert.run(
          profile.profile_id,
          wakeDay,
          start.toISOString(),
          end.toISOString(),
          30
        ).lastInsertRowid
      ),
    ];
    return () => {
      const cleanupDb = new Database(workerDbPath());
      try {
        cleanupDb.pragma("busy_timeout = 5000");
        cleanupDb
          .prepare("DELETE FROM metric_samples WHERE id IN (?, ?)")
          .run(...ids);
      } finally {
        cleanupDb.close();
      }
    };
  } finally {
    db.close();
  }
}

test("phone leads with the bounded Now lane", async ({ browser }) => {
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_NOWSTRIP,
  });
  try {
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true })
    ).toHaveCount(0);
    const strip = page.getByTestId("now-strip");
    await expect(strip).toBeVisible();
    await expect(strip).toHaveAttribute("data-count", "2");
    await expect(strip.getByTestId("now-strip-date")).toBeVisible();
    await expectNoClippedContent(page);
  } finally {
    await page.context().close();
  }
});

test("Now stays one column at every viewport", async ({ browser }) => {
  for (const options of [PHONE, DESKTOP]) {
    const page = await openDashboard(
      browser,
      { username: E2E_LOGIN_NOWSTRIP },
      options
    );
    try {
      const strip = page.getByTestId("now-strip");
      const cards = strip.locator("[data-testid^='now-strip-card-']");
      await expect(cards).toHaveCount(2);
      const [top, bottom] = await settledBoxes([cards.nth(0), cards.nth(1)]);
      expect(bottom.y).toBeGreaterThan(top.y + top.height / 2);
      expect(Math.abs(bottom.x - top.x)).toBeLessThan(2);
      expect(Math.abs(bottom.width - top.width)).toBeLessThan(2);
    } finally {
      await page.context().close();
    }
  }
});

test("desktop keeps the page header", async ({ browser }) => {
  const page = await openDashboard(
    browser,
    { username: E2E_LOGIN_NOWSTRIP },
    DESKTOP
  );
  try {
    await expect(
      page.getByRole("heading", { name: "Dashboard", exact: true })
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("an empty Now keeps its quiet state and mobile date", async ({
  browser,
}) => {
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_WHATSNEW,
  });
  try {
    const strip = page.getByTestId("now-strip");
    await expect(strip).toHaveAttribute("data-count", "0");
    await expect(strip.getByTestId("now-strip-empty")).toHaveText(
      "Nothing needs you."
    );
    await expect(strip.getByTestId("now-strip-date")).toBeVisible();
    await expect(strip.locator("[data-testid^='now-strip-card-']")).toHaveCount(
      0
    );
  } finally {
    await page.context().close();
  }
});

test("an ended nap moves into an otherwise-empty Now exactly once", async ({
  browser,
}) => {
  const cleanup = insertRecentlyEndedNap(E2E_LOGIN_WHATSNEW);
  try {
    const page = await openDashboard(browser, {
      username: E2E_LOGIN_WHATSNEW,
    });
    try {
      const naps = page.locator(
        '[data-testid="dashboard-candidate"][data-candidate-id^="sleep.nap:"]'
      );
      await expect(naps).toHaveCount(1);
      await expect(naps).toHaveAttribute("data-lane", "now");
      await expect(page.getByTestId("now-strip-empty")).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  } finally {
    cleanup();
  }
});

test("read-only safety facts remain uncapped and actionable", async ({
  browser,
}) => {
  const page = await openDashboard(browser, {
    username: E2E_LOGIN_NOWSAFETY,
  });
  try {
    await expect(page.getByTestId("now-strip-empty")).toHaveCount(0);
    const safety = page.locator(
      "[data-testid^='now-strip-card-attention.fact:mental-health:crisis']"
    );
    await expect(safety).toHaveCount(1);
    const fact = safety.getByTestId("dashboard-candidate");
    await expect(fact.getByTestId("dashboard-attention-atom")).toBeVisible();
    await expect(fact).toHaveAttribute("data-kind", "statement");
    await expect(fact).toHaveAttribute("data-lane", "now");
    const links = fact.getByRole("link");
    await expect(links).toHaveCount(1);
    await expect(links).toBeVisible();
    await expect(fact.getByRole("button")).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});
