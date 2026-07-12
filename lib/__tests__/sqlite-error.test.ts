import { describe, it, expect } from "vitest";
import { isUniqueConstraintError, sqliteErrorCode } from "@/lib/sqlite-error";

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
