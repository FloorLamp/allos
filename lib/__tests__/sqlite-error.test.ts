import { describe, it, expect } from "vitest";
import {
  isBusyError,
  isUniqueConstraintError,
  sqliteErrorCode,
} from "@/lib/sqlite-error";

describe("sqliteErrorCode", () => {
  it("reads the code off an error-like object", () => {
    expect(sqliteErrorCode({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(
      "SQLITE_CONSTRAINT_UNIQUE"
    );
  });

  it("returns null when there is no string code", () => {
    expect(sqliteErrorCode(new Error("boom"))).toBeNull();
    expect(sqliteErrorCode({ code: 19 })).toBeNull();
    expect(sqliteErrorCode(null)).toBeNull();
    expect(sqliteErrorCode("nope")).toBeNull();
  });
});

describe("isUniqueConstraintError", () => {
  it("matches UNIQUE and PRIMARY KEY violations", () => {
    expect(isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(
      true
    );
    expect(
      isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" })
    ).toBe(true);
  });

  it("does not match other constraint or non-constraint errors", () => {
    expect(isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_CHECK" })).toBe(
      false
    );
    expect(
      isUniqueConstraintError({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" })
    ).toBe(false);
    expect(isUniqueConstraintError({ code: "SQLITE_BUSY" })).toBe(false);
    expect(isUniqueConstraintError(new Error("plain"))).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
  });
});

describe("isBusyError (#3442)", () => {
  it("matches the plain code and every extended flavour", () => {
    expect(isBusyError({ code: "SQLITE_BUSY" })).toBe(true);
    // The one busy_timeout does NOT cover: a DEFERRED transaction's read snapshot
    // failing to upgrade to a write. Thrown immediately, and the retry is the only
    // thing that can rescue it.
    expect(isBusyError({ code: "SQLITE_BUSY_SNAPSHOT" })).toBe(true);
    expect(isBusyError({ code: "SQLITE_BUSY_RECOVERY" })).toBe(true);
    expect(isBusyError({ code: "SQLITE_BUSY_TIMEOUT" })).toBe(true);
  });

  it("does not match a locked-DATABASE message with no code, which is what broke", () => {
    // This is the exact value better-sqlite3's busy error stringifies to, and the
    // retired guard in runBootTx tested a string like it. Reading the code is the
    // fix precisely because this object has none.
    expect(isBusyError(new Error("database is locked"))).toBe(false);
    expect(isBusyError("SqliteError: database is locked")).toBe(false);
  });

  it("does not match other sqlite failures", () => {
    expect(isBusyError({ code: "SQLITE_CONSTRAINT_UNIQUE" })).toBe(false);
    expect(isBusyError({ code: "SQLITE_LOCKED" })).toBe(false);
    expect(isBusyError({ code: "SQLITE_READONLY" })).toBe(false);
    expect(isBusyError(undefined)).toBe(false);
  });
});
