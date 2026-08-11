import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { specsNeedingIsolation } from "../../vitest.isolation";

function scan(sources: Record<string, string>): string[] {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "allos-vitest-isolation-")
  );
  const dir = path.join(root, "specs");
  fs.mkdirSync(dir);
  try {
    for (const [name, source] of Object.entries(sources)) {
      fs.writeFileSync(path.join(dir, name), source);
    }
    return specsNeedingIsolation(root, ["specs"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe("Vitest shared-registry isolation routing", () => {
  it.each([
    ["mock", 'vi.mock("@/lib/auth")'],
    ["doMock", 'vi.doMock("@/lib/auth")'],
    ["unmock", 'vi.unmock("@/lib/auth")'],
    ["doUnmock", 'vi.doUnmock("@/lib/auth")'],
  ])("isolates vi.%s module registry changes", (_name, call) => {
    expect(scan({ "subject.test.ts": call })).toEqual([
      "specs/subject.test.ts",
    ]);
  });

  it("keeps detecting a module API after formatter line wrapping", () => {
    expect(
      scan({
        "subject.test.ts": 'vi\n  .doMock\n  ("@/lib/auth")',
      })
    ).toEqual(["specs/subject.test.ts"]);
  });

  it("does not confuse similarly named helpers with module registry changes", () => {
    expect(
      scan({
        "subject.test.ts": [
          "vi.mocked(value)",
          "vi.doMocked(value)",
          'vi.spyOn(console, "log")',
        ].join("\n"),
      })
    ).toEqual([]);
  });

  it("still isolates namespace spies on imported modules", () => {
    expect(
      scan({
        "subject.test.ts": [
          'import * as auth from "@/lib/auth";',
          'vi.spyOn(auth, "requireSession")',
        ].join("\n"),
      })
    ).toEqual(["specs/subject.test.ts"]);
  });
});
