import { test, expect } from "./fixtures";
import { type Page, type TestInfo } from "@playwright/test";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";
import { createFixtureProfile, destroyFixtureProfile } from "./fixture-profile";
import { E2E_LOGIN_DAILY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { SNAPSHOT_KINDS } from "@/lib/offline/snapshots";

// A SESSION ENDED SOMEWHERE ELSE, AND THE DEVICE THAT HOLDS THE RECORD (#3053, #3041).
//
// "Sign out all devices … on suspicion of compromise" ended the session row and nothing
// else: the phone kept the med list, kept rendering it session-free at /offline, and kept
// its write gate OPEN, so drafts and intents captured under a destroyed session survived
// into the next login. The server's answer to that phone was a bare 401 — the same answer
// an ordinary lapsed cookie gets — and #2994's pass-4 ruling is that a bare 401 must NOT
// wipe reads, because the common case is someone coming back tomorrow.
//
// The owner's 2026-08-20 ruling: the server says REVOKED rather than merely unauthorized,
// and the device wipes on that answer only. These three tests are the two sides of that
// sentence plus the switch that rides the same channel:
//
//   R1  a revoked session wipes the record and CLOSES the gate, at the next visit;
//   R2  an EXPIRED session wipes nothing — the guard the fix is most likely to break;
//   R3  #3041: offline reads turned off elsewhere reaches a device holding a COMPLETE
//       fresh set, which is the one case the old refresher never asked about.
//
// FIXTURE-OWNED (#868). Its own login and its own profile, created and destroyed here,
// because every test revokes or expires sessions for that login — pointed at a shared
// login it would sign every other spec in this worker out mid-run. No timezone override:
// the profile follows the run's pinned instance zone (e2e/pinned-timezone.ts).
test.use({ storageState: { cookies: [], origins: [] } });

const DB = "allos-offline";
const MED = "Revocation fixture med";

interface Fixture {
  username: string;
  password: string;
  loginId: number;
  profileId: number;
}

function createFixture(testInfo: TestInfo, tag: string): Fixture {
  const handle = new Database(workerDbPath());
  handle.pragma("busy_timeout = 5000");
  try {
    const suffix = `${tag}-${process.pid}-${testInfo.repeatEachIndex}`;
    const username = `e2e_revoke_${suffix}`;
    let loginId = 0;
    let profileId = 0;
    handle
      .transaction(() => {
        // Borrow a seeded login's hash rather than minting one: the password is the
        // seed's, so nothing high-entropy is written here.
        const passwordHash = (
          handle
            .prepare("SELECT password_hash FROM logins WHERE username = ?")
            .get(E2E_LOGIN_DAILY) as { password_hash: string }
        ).password_hash;
        profileId = createFixtureProfile(handle, `Revocation ${suffix}`);
        loginId = Number(
          handle
            .prepare(
              "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
            )
            .run(username, passwordHash).lastInsertRowid
        );
        handle
          .prepare(
            `INSERT INTO login_profiles (login_id, profile_id, access)
             VALUES (?, ?, 'write')`
          )
          .run(loginId, profileId);
        // One current medication, so "the health record is still on the device" is a
        // claim about a real name in a real payload rather than about five envelopes.
        const itemId = Number(
          handle
            .prepare(
              `INSERT INTO intake_items
                 (profile_id, name, notes, condition, obligation, kind, prescriber, active)
               VALUES (?, ?, 'Revocation fixture', 'daily', 'should', 'medication',
                       'Dr. Test Provider', 1)`
            )
            .run(profileId, MED).lastInsertRowid
        );
        handle
          .prepare(
            `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
             VALUES (?, '1 tablet', 'Morning', 'any', 0)`
          )
          .run(itemId);
        handle
          .prepare(
            `INSERT INTO medication_courses (item_id, started_on, stopped_on, stop_reason, notes)
             VALUES (?, date('now', '-30 days'), NULL, NULL, 'Ongoing — revocation fixture')`
          )
          .run(itemId);
      })
      .immediate();
    return { username, password: E2E_MEMBER_PASSWORD, loginId, profileId };
  } finally {
    handle.close();
  }
}

function destroyFixture(f: Fixture): void {
  const handle = new Database(workerDbPath());
  handle.pragma("busy_timeout = 5000");
  try {
    handle
      .transaction(() => {
        for (const sql of [
          "DELETE FROM sessions WHERE login_id = ?",
          "DELETE FROM login_profiles WHERE login_id = ?",
          "DELETE FROM login_settings WHERE login_id = ?",
          "DELETE FROM logins WHERE id = ?",
        ]) {
          handle.prepare(sql).run(f.loginId);
        }
        for (const child of ["intake_item_doses", "medication_courses"]) {
          handle
            .prepare(
              `DELETE FROM ${child} WHERE item_id IN
                 (SELECT id FROM intake_items WHERE profile_id = ?)`
            )
            .run(f.profileId);
        }
        handle
          .prepare("DELETE FROM intake_items WHERE profile_id = ?")
          .run(f.profileId);
        handle
          .prepare("DELETE FROM profile_settings WHERE profile_id = ?")
          .run(f.profileId);
        destroyFixtureProfile(handle, f.profileId);
      })
      .immediate();
  } finally {
    handle.close();
  }
}

/** Run `sql` against this worker's database — the server action's own statement, no more. */
function onServer(sql: string, ...params: unknown[]): void {
  const handle = new Database(workerDbPath());
  handle.pragma("busy_timeout = 5000");
  try {
    handle.prepare(sql).run(...(params as never[]));
  } finally {
    handle.close();
  }
}

async function login(page: Page, f: Fixture) {
  await page.goto("/login");
  await page.fill('input[name="username"]', f.username);
  await page.fill('input[name="password"]', f.password);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
}

// Read a store straight out of IndexedDB. MUST NOT CREATE THE DATABASE — a no-version
// `open` creates it at v1 and blocks the app's own v5 upgrade, which is a hang rather
// than an error (the lesson e2e/offline-snapshots.spec.ts records).
function storedRows(page: Page, storeName: string): Promise<unknown[]> {
  return page.evaluate(
    ([dbName, store]) =>
      (async () => {
        const known = await indexedDB.databases();
        if (!known.some((d) => d.name === dbName)) return [];
        return new Promise<unknown[]>((resolve) => {
          const req = indexedDB.open(dbName);
          req.onerror = () => resolve([]);
          req.onblocked = () => resolve([]);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(store)) {
              db.close();
              resolve([]);
              return;
            }
            const all = db
              .transaction(store, "readonly")
              .objectStore(store)
              .getAll();
            all.onerror = () => {
              db.close();
              resolve([]);
            };
            all.onsuccess = () => {
              const rows = all.result as unknown[];
              db.close();
              resolve(rows);
            };
          };
        });
      })(),
    [DB, storeName] as const
  );
}

async function storedKinds(page: Page): Promise<string[]> {
  const rows = (await storedRows(page, "snapshots")) as { kind: string }[];
  return rows.map((r) => r.kind).sort();
}

/** Whether the med's NAME is anywhere in the stored payloads — PHI at rest, on this device. */
async function medOnDevice(page: Page): Promise<boolean> {
  const rows = await storedRows(page, "snapshots");
  return JSON.stringify(rows).includes(MED);
}

/** The device write gate as it stands. `null` before anything has written it. */
async function gateRow(page: Page): Promise<Record<string, unknown> | null> {
  const rows = (await storedRows(page, "meta")) as Record<string, unknown>[];
  return rows.find((r) => r.key === "device-writes") ?? null;
}

/** Warm the device: one authenticated visit is the whole refresh policy. */
async function warm(page: Page, f: Fixture) {
  await login(page, f);
  await page.goto("/");
  await expect
    .poll(() => storedKinds(page), { timeout: 30_000 })
    .toEqual([...SNAPSHOT_KINDS].sort());
  expect(await medOnDevice(page), "the fixture med never reached the device").toBe(
    true
  );
}

/**
 * The device's next authenticated contact after the session ended elsewhere.
 *
 * A deliberate hard navigation, because that is what the issue's own reproduction does
 * and what a person does: the app bounces to /login, and the (app) layout — which is
 * where every offline component is mounted — never renders again. Whatever wipes has to
 * work from there.
 */
async function nextVisitBouncesToLogin(page: Page) {
  await page.goto("/medications");
  await page.waitForURL(/\/login/, { timeout: 20_000 });
}

test("R1 — a REVOKED session wipes the offline record and closes the write gate (#3053)", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const f = createFixture(testInfo, "r1");
  try {
    await warm(page, f);

    // THE REVOCATION IS DRIVEN THROUGH THE PRODUCT, from a second device, because that is
    // the claim: "Sign out everywhere else" is a Server Action that ends this device's
    // session row and nothing else, and until #3053 the phone kept the record anyway. A
    // raw DELETE against the fixture database would have proven only that the browser acts
    // on a state the spec itself invented; the seven server paths that must PRODUCE that
    // state are pinned per-path in lib/__db_tests__/session-revocation.test.ts.
    const other = await browser.newContext();
    try {
      const laptop = await other.newPage();
      await login(laptop, f);
      await laptop.goto("/settings/account");
      await laptop
        .getByRole("button", { name: "Sign out everywhere else" })
        .click();
      await expect(
        laptop.getByTestId("active-sessions"),
        "the second device never saw the sessions card"
      ).toContainText("1 device signed in", { timeout: 20_000 });
    } finally {
      await other.close();
    }

    await nextVisitBouncesToLogin(page);

    // THE READ HALF: nothing of the health record is left to render session-free.
    await expect.poll(() => storedKinds(page), { timeout: 20_000 }).toEqual([]);
    expect(await medOnDevice(page)).toBe(false);

    // THE WRITE HALF: the gate is CLOSED, so the device stops accepting drafts and
    // intents under the destroyed session — which is the contract lib/offline/draft-db.ts
    // states and `sessionClosed:false` broke.
    const gate = await gateRow(page);
    expect(gate, "the gate row is missing entirely").not.toBeNull();
    expect(gate?.sessionClosed).toBe(true);
  } finally {
    destroyFixture(f);
  }
});

test("R2 — an EXPIRED session wipes NOTHING (#2994 pass-4, untouched)", async ({
  page,
}, testInfo) => {
  test.slow();
  const f = createFixture(testInfo, "r2");
  try {
    await warm(page, f);

    // Ordinary expiry: the cookie lapsed while someone was away. The row is left in
    // place rather than deleted, which is the state `purgeExpiredSessions` has not swept
    // yet; R2b below covers the swept one.
    onServer(
      "UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE login_id = ?",
      f.loginId
    );

    await nextVisitBouncesToLogin(page);

    // Someone back from a fortnight's holiday still has their record. If this ever goes
    // red, the fix has started wiping on a bare 401 and is wrong.
    expect(await storedKinds(page)).toEqual([...SNAPSHOT_KINDS].sort());
    expect(await medOnDevice(page)).toBe(true);
    expect((await gateRow(page))?.sessionClosed ?? false).toBe(false);
  } finally {
    destroyFixture(f);
  }
});

test("R2b — an expired session SWEPT AWAY by the purge still wipes nothing (#2994 pass-4)", async ({
  page,
}, testInfo) => {
  test.slow();
  const f = createFixture(testInfo, "r2b");
  try {
    await warm(page, f);

    // The same lapse, after `purgeExpiredSessions` has run: the row is GONE, exactly as
    // it is after a revoke. Absence alone therefore cannot mean "revoked", and this is
    // the test that says so.
    onServer(
      "UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE login_id = ?",
      f.loginId
    );
    onServer(
      "DELETE FROM sessions WHERE login_id = ? AND expires_at <= datetime('now')",
      f.loginId
    );

    await nextVisitBouncesToLogin(page);

    expect(await storedKinds(page)).toEqual([...SNAPSHOT_KINDS].sort());
    expect(await medOnDevice(page)).toBe(true);
    expect((await gateRow(page))?.sessionClosed ?? false).toBe(false);
  } finally {
    destroyFixture(f);
  }
});

test("R3 — offline reads turned off elsewhere reaches a device holding a COMPLETE fresh set (#3041)", async ({
  page,
}, testInfo) => {
  test.slow();
  const f = createFixture(testInfo, "r3");
  try {
    await warm(page, f);

    // Nothing on this device is missing or stale, so the old refresher returned before
    // the fetch and the server was never asked. The switch moved on another device.
    onServer(
      `INSERT INTO profile_settings (profile_id, key, value) VALUES (?, 'offline_snapshots', '0')
         ON CONFLICT(profile_id, key) DO UPDATE SET value = '0'`,
      f.profileId
    );

    // An ordinary in-app visit — no payload is allowed to age first, which is the
    // acceptance criterion the issue states.
    await page.goto("/medications");
    await expect.poll(() => storedKinds(page), { timeout: 30_000 }).toEqual([]);
    expect(await medOnDevice(page)).toBe(false);

    // The reads switch is NOT a logout: the queue and drafts lanes stay open.
    expect((await gateRow(page))?.sessionClosed ?? false).toBe(false);
  } finally {
    destroyFixture(f);
  }
});
