import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "./strip-comments";

// docs/device-api.md's route table is Deck's view of allos (spaceport
// deck/backends/allos.json maps its ops onto it). Read as text, no DB: every row
// is a route file exporting that method behind that scope, every /v1 handler is a
// row, and every route but `needs` has its `/api` session twin (ask's is a POST).

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

type Row = { method: string; route: string; scope: string };

function docRows(): Row[] {
  const doc = fs.readFileSync(path.join(REPO, "docs/device-api.md"), "utf8");
  return [
    ...doc.matchAll(/^\| `(GET|POST) (\/v1\/[^`?\s]+)[^`]*` *\| `(\w+)` /gm),
  ].map(([, method, route, scope]) => ({ method, route, scope }));
}

function routeFile(route: string, base: "v1" | "api"): string {
  const rel = route.replace(/^\/v1/, "").replace(/<(\w+)>/g, "[$1]");
  return path.join(REPO, "app", base, rel, "route.ts");
}

function source(file: string): string {
  return stripComments(fs.readFileSync(file, "utf8"));
}

function exported(src: string): string[] {
  const reexports = [...src.matchAll(/export \{([^}]*)\}/g)].flatMap(([, n]) =>
    n.split(",").map((s) => s.trim())
  );
  return METHODS.filter(
    (m) =>
      new RegExp(`export (async function|const) ${m}\\b`).test(src) ||
      reexports.includes(m)
  );
}

// The scope the method's own handler asks for: the first authenticateDevice
// after its declaration.
function scopeOf(src: string, method: string): string | undefined {
  const at = src.search(
    new RegExp(`export (async function|const) ${method}\\b`)
  );
  if (at < 0) return undefined;
  return /authenticateDevice(?:Credential)?\(\s*\w+,\s*"allos:(\w+)"/.exec(
    src.slice(at)
  )?.[1];
}

function v1Routes(dir = path.join(REPO, "app/v1")): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return v1Routes(p);
    return e.name === "route.ts" ? [p] : [];
  });
}

describe("docs/device-api.md route table", () => {
  const rows = docRows();

  it("lists the /v1 routes", () => {
    expect(rows.length).toBeGreaterThan(5);
  });

  it("names a handler for each row, behind the row's scope", () => {
    for (const { method, route, scope } of rows) {
      const file = routeFile(route, "v1");
      expect(fs.existsSync(file), `${route}: ${file}`).toBe(true);
      const src = source(file);
      expect(exported(src), `${method} ${route}`).toContain(method);
      expect(scopeOf(src, method), `${method} ${route} scope`).toBe(scope);
    }
  });

  it("has a row for every /v1 handler", () => {
    const documented = new Set(
      rows.map((r) => `${r.method} ${routeFile(r.route, "v1")}`)
    );
    for (const file of v1Routes())
      for (const method of exported(source(file)))
        expect(
          documented.has(`${method} ${file}`),
          `${method} ${path.relative(REPO, file)} missing from docs/device-api.md`
        ).toBe(true);
  });

  it("gives every route but needs its /api session twin", () => {
    for (const { method, route } of rows) {
      if (route === "/v1/needs") continue;
      const file = routeFile(route, "api");
      expect(fs.existsSync(file), `${route} twin: ${file}`).toBe(true);
      const twin = route === "/v1/ask" ? ["POST"] : [method];
      const methods = exported(source(file));
      for (const m of twin)
        expect(methods, `${m} /api twin of ${route}`).toContain(m);
      if (route === "/v1/ask") expect(methods).not.toContain("GET");
    }
  });
});
