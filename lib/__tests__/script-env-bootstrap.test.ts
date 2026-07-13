// SOURCE-SCAN tier — standalone tsx scripts must load Next's env files before
// evaluating any dependency that can reach lib/db.ts. An inline loadEnvConfig()
// call is insufficient: ESM evaluates every static dependency before running the
// entrypoint body, which caused `npm run seed` to bootstrap a random admin password
// even when ADMIN_PASSWORD was present in .env.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const ENTRYPOINTS = [
  "scripts/seed.ts",
  "scripts/notify.ts",
  "scripts/backup.ts",
  "scripts/restore.ts",
  "scripts/demo-reset.ts",
  "scripts/gen-canonical-biomarkers.ts",
  "e2e/seed-events.ts",
] as const;

function staticImports(source: string): string[] {
  return [
    ...source.matchAll(/^import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["'];/gm),
  ].map((match) => match[1]);
}

describe("standalone script environment bootstrap", () => {
  it.each(ENTRYPOINTS)(
    "loads env before every other dependency: %s",
    (file) => {
      const source = fs.readFileSync(path.join(ROOT, file), "utf8");
      const imports = staticImports(source);
      const expected = file.startsWith("e2e/")
        ? "../scripts/load-env"
        : "./load-env";

      expect(imports[0]).toBe(expected);
      expect(source).not.toContain('from "@next/env"');
      expect(source).not.toContain("loadEnvConfig(");
    }
  );

  it("keeps the actual Next env loader in the bootstrap dependency", () => {
    const source = fs.readFileSync(
      path.join(ROOT, "scripts/load-env.ts"),
      "utf8"
    );
    expect(source).toContain('from "@next/env"');
    expect(source).toContain("loadEnvConfig(process.cwd())");
  });
});
