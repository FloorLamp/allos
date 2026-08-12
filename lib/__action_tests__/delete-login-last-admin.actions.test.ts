// SERVER-ACTION TIER — deleteLogin's last-admin guard is atomic (issue #2108).
//
// "The instance must keep at least one admin login" is ACCESS-CONTROL state, and
// AGENTS.md is explicit that such state needs an atomic transition or a
// compare-and-swap. The guard used to read `adminLoginCount()` OUTSIDE the write
// transaction and decide there, so the count it trusted was a snapshot taken before
// the lock existed — a second process on the same SQLite file deleting the OTHER
// admin in between would take the instance to zero admins through a check that had
// already passed. `setGrants` in the same module re-reads under the IMMEDIATE lock
// (the #467 discipline); this asserts the delete now does the same.
//
// The third test is the one that would fail on the old code: it records
// `db.inTransaction` at the moment the admin count is read.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { db } from "@/lib/db";
import { deleteLogin } from "@/app/(app)/settings/family/actions";
import { createLogin, createProfile, actAs } from "./harness";

const ADMIN_COUNT_SQL = "SELECT COUNT(*) AS c FROM logins WHERE role = 'admin'";

function loginExists(id: number): boolean {
  return db.prepare("SELECT 1 FROM logins WHERE id = ?").get(id) !== undefined;
}

function deleteForm(id: number): FormData {
  const f = new FormData();
  f.set("id", String(id));
  return f;
}

describe("deleteLogin last-admin guard (issue #2108)", () => {
  let actingProfile: ReturnType<typeof createProfile>;

  beforeEach(() => {
    // The acting identity is admin through the mocked session, so the DB's own admin
    // ROWS are free to be shaped per test. Start from a known floor: no admin rows at
    // all, then each test mints exactly the ones its story needs.
    db.prepare("UPDATE logins SET role = 'member' WHERE role = 'admin'").run();
    const acting = createLogin({ role: "member" });
    actingProfile = createProfile("Acting Home");
    actAs({ ...acting, role: "admin" }, actingProfile);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses to delete the only admin login, and deletes nothing", async () => {
    const onlyAdmin = createLogin({ role: "admin" });
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(onlyAdmin.id, actingProfile.id);

    const res = await deleteLogin(deleteForm(onlyAdmin.id));
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("only admin login");
    expect(loginExists(onlyAdmin.id)).toBe(true);
    // The teardown writes are inside the same transaction as the guard, so a
    // refusal leaves the login's grants untouched too.
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM login_profiles WHERE login_id = ?")
        .get(onlyAdmin.id)
    ).toEqual({ c: 1 });
  });

  it("deletes an admin while another admin remains, tearing down its rows", async () => {
    const keeper = createLogin({ role: "admin" });
    const doomed = createLogin({ role: "admin" });
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(doomed.id, actingProfile.id);
    db.prepare(
      "INSERT INTO login_settings (login_id, key, value) VALUES (?, 'weight_unit', 'kg')"
    ).run(doomed.id);

    const res = await deleteLogin(deleteForm(doomed.id));
    expect(res.ok).toBe(true);
    expect(loginExists(doomed.id)).toBe(false);
    expect(loginExists(keeper.id)).toBe(true);
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM login_profiles WHERE login_id = ?")
        .get(doomed.id)
    ).toEqual({ c: 0 });
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM login_settings WHERE login_id = ?")
        .get(doomed.id)
    ).toEqual({ c: 0 });
  });

  it("reports a missing login without opening a hole in the guard", async () => {
    createLogin({ role: "admin" });
    const res = await deleteLogin(deleteForm(987654));
    expect(res).toEqual({ ok: false, error: "Login not found." });
  });

  it("reads the admin count INSIDE the write transaction", async () => {
    createLogin({ role: "admin" });
    const doomed = createLogin({ role: "admin" });

    // Record whether a transaction was open each time the guard's count is prepared.
    // On the pre-#2108 shape this is `false`: the count ran before writeTx existed.
    const seen: boolean[] = [];
    const realPrepare = db.prepare.bind(db);
    vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
      if (sql === ADMIN_COUNT_SQL) seen.push(db.inTransaction);
      return realPrepare(sql);
    }) as typeof db.prepare);

    const res = await deleteLogin(deleteForm(doomed.id));
    expect(res.ok).toBe(true);
    expect(seen).toEqual([true]);
  });
});
