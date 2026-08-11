import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The app's build and generated-route typecheck now exceed V8's automatic
// old-space limit on ordinary developer/CI hosts. This is a source guard rather
// than a memory-allocation test: actually consuming 2+ GiB in the pure tier would
// make the protection more expensive and less deterministic than the failure it
// prevents.
//
// There are three launch points. package.json owns the normal build and tsc paths;
// Playwright's local bootstrap intentionally invokes Next directly, so it must carry
// the same limit rather than assuming the package script applies transitively.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const REQUIRED_HEAP_MB = 4096;

describe("memory-heavy Node launchers", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(REPO, "package.json"), "utf8")
  ) as { scripts: Record<string, string> };

  it("gives both the Next build and TypeScript gate 4 GiB of old space", () => {
    expect(pkg.scripts.build).toContain(
      `node --max-old-space-size=${REQUIRED_HEAP_MB}`
    );
    expect(pkg.scripts.build).toContain("next/dist/bin/next build");

    const [, tsc] = pkg.scripts.typecheck
      .split("&&")
      .map((part) => part.trim());
    expect(tsc).toContain(`node --max-old-space-size=${REQUIRED_HEAP_MB}`);
    expect(tsc).toContain("typescript/bin/tsc --noEmit");
  });

  it("gives Playwright's direct local build the same heap", () => {
    const setup = fs.readFileSync(
      path.join(REPO, "e2e", "global-setup.ts"),
      "utf8"
    );
    expect(setup).toContain(`const BUILD_HEAP_MB = ${REQUIRED_HEAP_MB};`);
    expect(setup).toContain(
      '`--max-old-space-size=${BUILD_HEAP_MB}`, bin("next"), "build"'
    );
  });
});
