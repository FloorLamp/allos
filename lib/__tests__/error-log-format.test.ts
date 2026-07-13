import { describe, it, expect } from "vitest";
import {
  capDetail,
  redactSecrets,
  buildDetail,
  shouldRotate,
  keepRecentLines,
  parseErrorLine,
} from "../error-log-format";

describe("capDetail", () => {
  it("passes short strings through", () => {
    expect(capDetail("hello", 100)).toBe("hello");
  });
  it("truncates and annotates over-long strings", () => {
    const out = capDetail("a".repeat(50), 10);
    expect(out.startsWith("aaaaaaaaaa")).toBe(true);
    expect(out).toContain("(+40 chars)");
  });
});

describe("redactSecrets", () => {
  it("masks Bearer tokens", () => {
    expect(redactSecrets("sent header Bearer abc123.def-456")).toBe(
      "sent header Bearer ***"
    );
  });
  it("masks the value of an Authorization header key", () => {
    // Both rules fire (key rule + Bearer rule); either way the secret is gone.
    const out = redactSecrets("Authorization: Bearer abc123.def-456");
    expect(out).not.toContain("abc123");
  });
  it("masks sensitive key=value pairs", () => {
    expect(redactSecrets("token=supersecret&user=ada")).toBe(
      "token=***&user=ada"
    );
  });
  it("masks JSON secret fields but keeps the key", () => {
    const out = redactSecrets('{"password":"hunter2","name":"Ada"}');
    expect(out).toContain('"password":"***"');
    expect(out).toContain('"name":"Ada"');
  });
  it("leaves non-secret text untouched", () => {
    expect(redactSecrets("failed to save body_metrics for profile 3")).toBe(
      "failed to save body_metrics for profile 3"
    );
  });
  it("is a no-op on empty input", () => {
    expect(redactSecrets("")).toBe("");
  });
});

describe("buildDetail", () => {
  it("returns undefined with no fields", () => {
    expect(buildDetail(undefined)).toBeUndefined();
    expect(buildDetail({})).toBeUndefined();
  });
  it("extracts an Error stack", () => {
    const err = new Error("boom");
    const out = buildDetail({ err });
    expect(out).toContain("boom");
  });
  it("serializes plain fields as JSON", () => {
    const out = buildDetail({ profileId: 3, action: "save" });
    expect(out).toContain('"profileId":3');
    expect(out).toContain('"action":"save"');
  });
  it("redacts secrets found in fields", () => {
    const out = buildDetail({ headers: "authorization=Bearer xyz" });
    expect(out).not.toContain("xyz");
  });
  it("caps very long detail", () => {
    const out = buildDetail({ blob: "x".repeat(9000) }, 100);
    expect(out!.length).toBeLessThan(200);
    expect(out).toContain("chars)");
  });
});

describe("shouldRotate", () => {
  it("trips on bytes over budget", () => {
    expect(shouldRotate(6_000_000, 10, 5_000_000, 2000)).toBe(true);
  });
  it("trips on line count over budget", () => {
    expect(shouldRotate(100, 3000, 5_000_000, 2000)).toBe(true);
  });
  it("stays put when both are under budget", () => {
    expect(shouldRotate(100, 10, 5_000_000, 2000)).toBe(false);
  });
});

describe("keepRecentLines", () => {
  it("keeps the newest N non-empty lines", () => {
    const lines = ["a", "b", "", "c", "d"];
    expect(keepRecentLines(lines, 2)).toEqual(["c", "d"]);
  });
  it("drops empty lines from the count", () => {
    expect(keepRecentLines(["a", "", "b", ""], 5)).toEqual(["a", "b"]);
  });
});

describe("parseErrorLine", () => {
  it("parses a valid event line", () => {
    const line = JSON.stringify({
      id: "1-000001",
      time: "2026-07-13T00:00:00.000Z",
      level: "error",
      message: "boom",
    });
    const ev = parseErrorLine(line);
    expect(ev?.message).toBe("boom");
    expect(ev?.level).toBe("error");
  });
  it("rejects blank and malformed lines", () => {
    expect(parseErrorLine("")).toBeNull();
    expect(parseErrorLine("   ")).toBeNull();
    expect(parseErrorLine("{not json")).toBeNull();
  });
  it("rejects objects missing required fields", () => {
    expect(parseErrorLine(JSON.stringify({ id: "1" }))).toBeNull();
    expect(parseErrorLine(JSON.stringify({ message: "x" }))).toBeNull();
  });
});
