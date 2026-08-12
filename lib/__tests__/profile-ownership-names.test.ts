import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), {
    withFileTypes: true,
  })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith("__") || entry.name === "node_modules")
        continue;
      out.push(...sourceFiles(relative));
    } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      out.push(relative);
    }
  }
  return out;
}

describe("profile-owned API vocabulary (#2481)", () => {
  it("names profile health attributes after their profile owner", () => {
    const source = read("lib/settings/profile-attrs.ts");
    for (const name of [
      "getProfileSex",
      "setProfileSex",
      "getProfileReproductiveStatus",
      "setProfileReproductiveStatus",
      "getProfileFullName",
      "setProfileFullName",
      "getProfileBirthdate",
      "setProfileBirthdate",
      "getProfileAge",
      "getProfileAgeOn",
      "profileAgeResolver",
    ]) {
      // Either declaration form satisfies the #2481 rule, which is about the
      // NAME: a plain `export function`, or the request-scoped
      // `export const X = cache(function X(...))` that a repeated read declares
      // (getProfileBirthdate — see the hoisting/cache() rule in AGENTS.md). The
      // cached form must repeat the same name on the inner function, so the
      // vocabulary stays checkable and a stack frame still says what it is.
      expect(source, name).toMatch(
        new RegExp(
          `export function ${name}\\b|export const ${name} = cache\\(function ${name}\\b`
        )
      );
    }
    expect(source).not.toMatch(/export function (?:get|set)User[A-Z]/);
  });

  it("has no stale profile-health getUser/setUser call sites", () => {
    const stale =
      /\b(?:getUserSex|setUserSex|getUserReproductiveStatus|setUserReproductiveStatus|getUserFullName|setUserFullName|getUserBirthdate|setUserBirthdate|getUserAge|getUserAgeOn|userAgeResolver)\b/;
    const offenders = ["app", "components", "lib", "scripts"]
      .flatMap(sourceFiles)
      .filter((relative) => stale.test(read(relative)));
    expect(offenders).toEqual([]);
  });

  it("separates login-session teardown from profile-context changes", () => {
    expect(existsSync(path.join(ROOT, "app/(app)/user-actions.ts"))).toBe(
      false
    );
    const session = read("app/(app)/session-actions.ts");
    const profileContext = read("app/(app)/profile-context-actions.ts");

    expect(session).toContain("export async function logoutAction");
    expect(session).not.toMatch(/(?:switch|setView)ProfileAction/);
    expect(profileContext).toContain(
      "export async function switchProfileAction"
    );
    expect(profileContext).toContain(
      "export async function setViewProfileAction"
    );
    expect(profileContext).not.toContain("logoutAction");
  });
});
