// THE SHIPPED CROSS-PROFILE WRITE GATE, EXECUTED (#5030).
//
// `requireProfileWriteAccess` is the authoritative boundary for a Server Action that
// mutates a profile other than the session's active one. Until this file nothing below
// e2e ran its body: `lib/__action_tests__/setup.ts` mocks `@/lib/auth` with a hand-written
// factory carrying its OWN copy of the gate, and `vitest.db.config.ts` loads that setup for
// BOTH db-tier projects. The action tests therefore prove that each action CALLS a gate and
// that the MOCK's contract refuses — not that the shipped gate implements that contract.
// The filer measured it: deleting either production check left
// `lib/__action_tests__/medications-multi-view.actions.test.ts` fully green.
//
// So this file restores the real module and gives the gate the two request-shaped inputs it
// needs — a cookie to resolve and a `redirect()` that can be observed — over the same real
// temp database every other spec in this tier uses. Nothing here re-states the
// implementation; a mirror of the body is the failure #5030 names, not a fix for it.
//
// `./auth.test.ts` covers the DB-callable cores of lib/auth and says in its header that the
// cookie/redirect SHELLS are deliberately out of its scope. This file is that scope, for the
// one shell that is a security boundary.

import { describe, it, expect, beforeAll, vi } from "vitest";

// The gate reads a cookie and refuses by throwing out of `redirect()`. Both are hoisted so
// the factories can close over them: `@/lib/auth` imports `next/headers` and
// `next/navigation` while THIS module's own body is still evaluating.
const request = vi.hoisted(() => {
  const jar = new Map<string, string>();
  // Shaped like Next's own refusal: `redirect()` THROWS, which is the whole reason a
  // refused cross-profile POST never reaches its write. `it("throws out of the real
  // next/navigation redirect")` below pins that this stand-in is not more forgiving than
  // the framework it stands in for.
  class RedirectSignal extends Error {
    constructor(readonly to: string) {
      super(`redirect(${to})`);
    }
  }
  return { jar, RedirectSignal };
});

// This tier's shared setup mocks @/lib/auth for the server-action suite. THIS file is about
// lib/auth itself, so restore the real module for this file only — the same one-line escape
// ./auth.test.ts uses, and the reason both files run in the isolated project.
vi.mock("@/lib/auth", async () => vi.importActual("@/lib/auth"));

// Only `cookies` and `redirect` are replaced; the rest of each module is passed through, so
// anything else in the action graph that reaches for `headers()` still gets the real thing.
vi.mock("next/headers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/headers")>()),
  cookies: async () => ({
    get: (name: string) =>
      request.jar.has(name)
        ? { name, value: request.jar.get(name)! }
        : undefined,
    set: () => {},
    delete: () => {},
  }),
}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (to: string) => {
    throw new request.RedirectSignal(to);
  },
}));

import { db, today } from "@/lib/db";
import {
  SESSION_COOKIE,
  accessForProfile,
  createSession,
  requireProfileWriteAccess,
} from "@/lib/auth";
import { setDoseStatus } from "@/app/(app)/nutrition/intake-actions";

// ── The instrument for the ORDER of the two checks ───────────────────────────────────
//
// Both guards refuse the same way, so the ORDER decides no answer this tier could read:
// "refuse unless reachable AND write" is the same proposition whichever `if` comes first.
// What the order does decide is WHICH QUESTION THE GATE ASKS — production settles
// reachability first and redirects before the grant table is consulted about a profile the
// login cannot reach. That is the observable, and it is read off the real prepared
// statements the real body runs, not off a copy of the body.
//
// `hoistedStatement` (lib/db.ts) compiles lazily through `db.prepare` and caches per
// connection, so wrapping `db.prepare` before the first gate call puts the recorder inside
// every later execution of those two statements. Installed in `beforeAll` for that reason:
// a statement already compiled would be invisible, which is why the reachable row of the
// ordering table is a positive control through the SAME recorder rather than a fresh query.
type Asked = { statement: "reachable-set" | "grant-access"; args: unknown[] };
const asked: Asked[] = [];

function label(sql: string): Asked["statement"] | null {
  const flat = sql.replace(/\s+/g, " ").trim();
  if (/^SELECT access FROM login_profiles\b/i.test(flat)) return "grant-access";
  if (/FROM profiles p JOIN login_profiles\b/i.test(flat)) return "reachable-set";
  return null;
}

beforeAll(() => {
  const prepare = db.prepare.bind(db);
  vi.spyOn(db, "prepare").mockImplementation(((sql: string) => {
    const statement = prepare(sql);
    const name = label(sql);
    if (!name) return statement;
    return new Proxy(statement, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== "function") return value;
        const call = value as (...a: unknown[]) => unknown;
        if (prop !== "get" && prop !== "all" && prop !== "run") {
          return call.bind(target);
        }
        return (...args: unknown[]) => {
          asked.push({ statement: name, args });
          return call.apply(target, args);
        };
      },
    });
  }) as never);
});

// Whether the gate asked the grant table about THIS profile. `resolveSessionToken` asks
// about the session's ACTIVE profile on every request, so the target id — never the acting
// one — is what separates the gate's own question from the session's.
function grantTableAskedAbout(profileId: number): boolean {
  return asked.some(
    (a) => a.statement === "grant-access" && a.args[1] === profileId
  );
}

// ── Fixture ──────────────────────────────────────────────────────────────────────────

let seq = 0;
function mkLogin(role: "admin" | "member"): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role) VALUES (?, 'x', ?)"
      )
      .run(`gate_${role}_${++seq}`, role).lastInsertRowid
  );
}

function mkProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A caregiver MEMBER granted home (write, and the profile the session acts as), kid
// (write) and readOnly (read); `stranger` is granted to nobody. Plus an ADMIN, who holds
// no grant row at all and must still reach every profile.
function seedHousehold() {
  const member = mkLogin("member");
  const admin = mkLogin("admin");
  const home = mkProfile(`Gate Home ${seq}`);
  const kid = mkProfile(`Gate Kid ${seq}`);
  const readOnly = mkProfile(`Gate Read Only ${seq}`);
  const stranger = mkProfile(`Gate Stranger ${seq}`);
  for (const [profileId, access] of [
    [home, "write"],
    [kid, "write"],
    [readOnly, "read"],
  ] as const) {
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, ?)"
    ).run(member, profileId, access);
  }
  return { member, admin, home, kid, readOnly, stranger };
}

type Household = ReturnType<typeof seedHousehold>;

// The four subjects, as (which login signs in, which profile it targets).
const SUBJECT = {
  admin: (h: Household) => ({ login: h.admin, target: h.stranger }),
  write: (h: Household) => ({ login: h.member, target: h.kid }),
  read: (h: Household) => ({ login: h.member, target: h.readOnly }),
  ungranted: (h: Household) => ({ login: h.member, target: h.stranger }),
} as const;

// A real sessions row for this login, and the cookie that resolves to it.
function signIn(loginId: number): void {
  request.jar.set(SESSION_COOKIE, createSession(loginId, "gate-test").token);
}

// ── The gate's contract, run through the shipped body ────────────────────────────────

describe("requireProfileWriteAccess (the shipped body)", () => {
  it.each([
    ["an admin, who holds no grant row at all", "admin", "pass"],
    ["a member holding a write grant on the target", "write", "pass"],
    ["a member holding a read-only grant on the target", "read", "refuse"],
    ["a member holding no grant on the target", "ungranted", "refuse"],
  ] as const)("%s: %s", async (_who, subject, outcome) => {
    const household = seedHousehold();
    const { login, target } = SUBJECT[subject](household);
    signIn(login);

    if (outcome === "pass") {
      const session = await requireProfileWriteAccess(target);
      expect(session.login.id).toBe(login);
    } else {
      // One refusal for both shapes, and that is the shipped behaviour: a read-only grant
      // and an unreachable profile are bounced to the app root identically, so nothing
      // downstream can tell a caregiver's own household apart from a stranger's.
      await expect(requireProfileWriteAccess(target)).rejects.toThrow(
        request.RedirectSignal
      );
      await expect(requireProfileWriteAccess(target)).rejects.toMatchObject({
        to: "/",
      });
    }
  });

  // WHY THE REACHABILITY CHECK CANNOT BE DROPPED IN FAVOUR OF THE ACCESS ONE. For a member
  // with no grant row, `accessForProfile` answers "write" — by design (lib/auth.ts: anything
  // but an explicit 'read' reads as write, so drift can only ever be permissive). It is
  // therefore incapable of refusing this subject, and the refusal above can only have come
  // from the reachability check that ran first.
  it("answers 'write' for the very subject the gate refuses as unreachable", () => {
    const { member, stranger } = seedHousehold();
    expect(accessForProfile(member, "member", stranger)).toBe("write");
  });

  // The order, read as the question the gate asks. The reachable row is the positive
  // control: it proves this recorder CAN see a grant-table read keyed to the target, so the
  // unreachable row's `false` is an absence the instrument could have contradicted.
  it.each([
    ["a reachable target", "write", true],
    ["an unreachable target", "ungranted", false],
  ] as const)(
    "consults the grant table for %s: %s",
    async (_what, subject, expected) => {
      const household = seedHousehold();
      const { login, target } = SUBJECT[subject](household);
      signIn(login);

      asked.length = 0;
      await requireProfileWriteAccess(target).catch(() => {});

      expect(
        asked.some((a) => a.statement === "reachable-set"),
        "the gate must resolve the login's reachable set"
      ).toBe(true);
      expect(grantTableAskedAbout(target)).toBe(expected);
    }
  );

  // The stand-in for `redirect()` above only proves anything if the real one aborts too.
  it("throws out of the real next/navigation redirect", async () => {
    const actual =
      await vi.importActual<typeof import("next/navigation")>(
        "next/navigation"
      );
    expect(() => actual.redirect("/")).toThrow();
  });
});

// ── The refusal reaches the caller before the write ──────────────────────────────────
//
// The contract above is about the gate; this is about what a refused Server Action leaves
// behind. `setDoseStatus` is a real cross-profile mutating action — it gates the posted
// target and then writes — and here it runs against the SHIPPED gate rather than the
// action tier's mock, so a refusal has to abort it before `intake_item_logs` gains a row.

function seedScheduledDose(profileId: number): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Lisinopril', 1, 'medication', 'daily', 'should')`
      )
      .run(profileId).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '10 mg', 'any', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
}

function doseStatus(doseId: number, date: string): string | undefined {
  return (
    db
      .prepare(
        "SELECT status FROM intake_item_logs WHERE dose_id = ? AND date = ?"
      )
      .get(doseId, date) as { status: string } | undefined
  )?.status;
}

describe("a cross-profile Server Action gated by the shipped body", () => {
  it.each([
    ["a write grant lets the dose through", "write", "taken"],
    ["a read-only grant leaves no row", "read", undefined],
    ["no grant leaves no row", "ungranted", undefined],
  ] as const)("%s", async (_what, subject, expected) => {
    const household = seedHousehold();
    const { login, target } = SUBJECT[subject](household);
    signIn(login);
    const doseId = seedScheduledDose(target);

    const form = new FormData();
    form.set("dose_id", String(doseId));
    form.set("status", "taken");
    form.set("profileId", String(target));

    if (expected === "taken") {
      expect((await setDoseStatus(form)).ok).toBe(true);
    } else {
      await expect(setDoseStatus(form)).rejects.toThrow(
        request.RedirectSignal
      );
    }
    expect(doseStatus(doseId, today(target))).toBe(expected);
  });
});
