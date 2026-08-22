import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE WEB-SURFACE WIRING CENSUS (#3087).
//
// `parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page")` is a Server Action asking
// "which of my mountings posted this?". The answer only exists if a mounting actually
// declares it, and NOTHING IN THE TYPE SYSTEM CONNECTS THE TWO: an action that reads
// the field compiles perfectly with no client ever setting it, takes its fallback on
// every request, and records `page` for the dashboard, the quick-log sheet and the
// command palette alike. That is not hypothetical — it is the state this guard was
// written to end. The mechanism was wired at three components against seventeen read
// sites, so `dashboard-widget` was produced by exactly one control in the whole app.
//
// WHY THIS ASSERTS THE MECHANISM AND NOT A LIST. A list of wired components is a
// snapshot: it goes stale the moment a new action starts reading the field, and it
// says nothing when a component stops declaring. This walks the UNION instead — every
// `parseWebOrigin` read site, resolved to its exported action, resolved to the client
// files that import that action — and fails when any of those clients has no way to
// say where it is. Add a read site with no declaring mounting and this goes red.
//
// A CLIENT DECLARES in one of two ways, and both are the same mechanism: it stamps a
// FormData through `useLoggedViaStamp()` / `LOGGED_VIA_FIELD`, or it renders
// `<LoggedViaField />` inside a plain `<form action={…}>`. A file that is itself a
// REGION ROOT (`<LoggedViaSurface value=…>`) counts too: declaring the region is what
// the controls inside it read.
//
// READS BYTES rather than shelling out to a grep, for the #3206 reason the sibling
// census states: a source file carrying a deliberate NUL separator is BINARY to grep
// and would be skipped, so a shelled-out sweep would report a pass it never took.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** A `parseWebOrigin(` read, wherever it sits. */
const READ_RE = /parseWebOrigin\s*\(/g;
/** `export async function name(` / `export function name(` — the action boundary. */
const EXPORT_RE = /^export\s+(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(/gm;

/** The spellings of "this file declares a surface". */
const DECLARES_RE =
  /useLoggedViaStamp|LoggedViaField|LoggedViaSurface|LOGGED_VIA_FIELD/;

function dirents(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walk(root: string, sub: string): string[] {
  const out: string[] = [];
  const rec = (dir: string): void => {
    for (const entry of dirents(dir)) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".next") continue;
        rec(p);
        continue;
      }
      if (!p.endsWith(".ts") && !p.endsWith(".tsx")) continue;
      const rel = path.relative(root, p).split(path.sep).join("/");
      if (/__(?:db_|action_)?tests__/.test(rel)) continue;
      if (p.endsWith(".test.ts") || p.endsWith(".test.tsx")) continue;
      out.push(p);
    }
  };
  rec(path.join(root, sub));
  return out.sort();
}

/** Every exported action in `app/` that READS a posted surface. */
export function readingActions(root: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of walk(root, "app")) {
    const src = fs.readFileSync(file, "utf8");
    // Where each exported function starts, so a read can be attributed to the last
    // one that opened before it.
    const bounds: { name: string; at: number }[] = [];
    for (const m of src.matchAll(EXPORT_RE))
      bounds.push({ name: m[1], at: m.index ?? 0 });
    for (const m of src.matchAll(READ_RE)) {
      const at = m.index ?? 0;
      let owner: string | null = null;
      for (const b of bounds) if (b.at < at) owner = b.name;
      if (owner) {
        out.set(owner, path.relative(root, file).split(path.sep).join("/"));
      }
    }
  }
  return out;
}

/** Every "use client" file, with the source that decides whether it declares. */
function clientFiles(root: string): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  for (const sub of ["app", "components"]) {
    for (const file of walk(root, sub)) {
      const src = fs.readFileSync(file, "utf8");
      if (!/^\s*["']use client["']/.test(src)) continue;
      out.push({
        rel: path.relative(root, file).split(path.sep).join("/"),
        src,
      });
    }
  }
  return out;
}

/**
 * Does this client file IMPORT the named action?
 *
 * Matching on the IMPORT — not on a bare `name(` — is what keeps the census from
 * over-matching a comment that mentions the symbol: a client cannot post a Server
 * Action it has not imported.
 */
function importsSymbol(src: string, name: string): boolean {
  for (const m of src.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*["'][^"']+["']/g
  )) {
    const named = m[1]
      .split(",")
      .map((s) =>
        s
          .trim()
          .split(/\s+as\s+/)[0]
          .trim()
      )
      .filter(Boolean);
    if (named.includes(name)) return true;
  }
  return false;
}

/** Every (client file, action) pair where a poster declares no surface. */
export function unwiredPosters(root: string): string[] {
  const actions = readingActions(root);
  const clients = clientFiles(root);
  const out: string[] = [];
  for (const { rel, src } of clients) {
    if (DECLARES_RE.test(src)) continue;
    for (const [action, file] of actions) {
      if (importsSymbol(src, action))
        out.push(`${rel} posts ${action} (${file})`);
    }
  }
  return [...new Set(out)].sort();
}

/**
 * Which client files DECLARE a region, and which surface each declares.
 *
 * Accepts both spellings the tree uses: the literal (`<LoggedViaSurface value="…">`)
 * and a file-local constant (`const X: WebLoggedVia = "…"`, which the command palette
 * needs because a component is not inside the provider it renders and so has to name
 * its own surface once for both uses).
 */
export function regionRoots(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  // EVERY file, not just the client ones: a region root is often a SERVER component
  // that renders the client provider around server children — the dashboard is exactly
  // that. Scoping this to `"use client"` files would have reported the dashboard's own
  // declaration as missing, which is the "fails toward a plausible correction" shape.
  for (const sub of ["app", "components"]) {
    for (const file of walk(root, sub)) {
      const rel = path.relative(root, file).split(path.sep).join("/");
      const src = fs.readFileSync(file, "utf8");
      if (!src.includes("<LoggedViaSurface")) continue;
      const values = new Set<string>();
      for (const m of src.matchAll(/<LoggedViaSurface\s+value="([a-z-]+)"/g))
        values.add(m[1]);
      for (const m of src.matchAll(/:\s*WebLoggedVia\s*=\s*"([a-z-]+)"/g))
        values.add(m[1]);
      for (const v of values) out.set(v, [...(out.get(v) ?? []), rel]);
    }
  }
  return out;
}

describe("every surface-reading action has a mounting that declares itself", () => {
  it("has a corpus to make a claim about", () => {
    // AN ABSENCE ASSERTION FAILS OPEN, so the floors come first: a broken walker
    // finds no read sites and no clients, and reports a clean sweep it never took.
    // The numbers are floors measured on 2026-08-22 (17 reads across 9 action files,
    // and well over a hundred client files), set below the real figures so ordinary
    // churn does not trip them and a collapsed scan does.
    const actions = readingActions(REPO);
    expect(actions.size).toBeGreaterThanOrEqual(12);
    // The named subject: the action #3087's own illustration turns on.
    expect([...actions.keys()]).toContain("logFoodServing");
    expect(clientFiles(REPO).length).toBeGreaterThanOrEqual(50);
  });

  it("has a REGION ROOT producing every non-default web surface", () => {
    // THE OTHER DIRECTION OF THE UNION, and the one the poster check cannot see. Every
    // control inside the quick-log sheet declares itself correctly through the hook —
    // and reports `page` for ever if the SHEET stops declaring the region, because the
    // context then answers its default and every child agrees with it. Nothing about
    // the children changes, so nothing about them can go red.
    //
    // So the vocabulary is asked to be REACHABLE: a value a browser may claim, that no
    // mounting in the whole app produces, is a value the column will never hold and a
    // sentence in `LOGGED_VIA_MEANING` that describes nothing. Deleting a value is a
    // deliberate act; losing one by deleting a wrapper is not.
    //
    // `page` is deliberately absent: it is the context's default, so it is produced by
    // every mounting that declares nothing and cannot go missing.
    //
    // WHAT THIS DOES NOT CATCH, stated so nobody reads it as more than it is: the
    // question is REACHABILITY, not per-region survival. `quick-log` is declared by
    // both the quick-log sheet and the command palette, so deleting ONE of those two
    // wrappers leaves this green while every control in that region silently reverts
    // to `page`. Measured deliberately, by deleting each in turn. Closing it needs a
    // per-region assertion, and a list of regions is the shape this file exists to
    // avoid — so the gap is named rather than papered over.
    const roots = regionRoots(REPO);
    for (const surface of ["quick-log", "dashboard-widget"] as const) {
      expect(
        roots.get(surface) ?? [],
        `No mounting in the app declares \`${surface}\` (#3087), so no web write can ` +
          "ever record it. Either a region root lost its `<LoggedViaSurface>` wrapper, " +
          "or the value should come out of the vocabulary — but a vocabulary member " +
          "nothing produces describes nothing."
      ).not.toEqual([]);
    }
    // `dashboard-hero` is the attention card, whose actions are single-surface and name
    // it themselves (app/(app)/actions.ts) rather than reading a post — so it has no
    // region root by design, and asserting one here would be asserting a fiction.
    expect(roots.get("dashboard-hero")).toBeUndefined();
  });

  it("leaves no client posting a surface-reading action with no way to say where it is", () => {
    expect(
      unwiredPosters(REPO),
      "A client component posts a Server Action that reads `logged_via` off the " +
        "post, but declares no surface (#3087). Either stamp its FormData through " +
        "`useLoggedViaStamp()`, render `<LoggedViaField />` inside its form, or — " +
        "if it is a region root — wrap its subtree in `<LoggedViaSurface value=…>`. " +
        "Without one of those the action takes its `page` fallback on every request " +
        "from this mounting, whatever surface it actually is."
    ).toEqual([]);
  });
});

describe("the census's reach", () => {
  // A GREEN SWEEP OVER A COMPLYING TREE SAYS NOTHING ABOUT WHAT THE SWEEP CAN SEE, so
  // the offenders are planted on disk and the WHOLE walker runs over them — the file
  // selection, the "use client" test, the export attribution and the import match.
  function corpus(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "logged-via-wiring-"));
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(root, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    return root;
  }

  const ACTION = `"use server";
export async function logThing(formData: FormData) {
  return core(parseWebOrigin(formData.get(LOGGED_VIA_FIELD), "page"));
}
`;

  it("sees a client that posts a reading action and declares nothing", () => {
    const root = corpus({
      "app/(app)/x/actions.ts": ACTION,
      "components/ThingBar.tsx":
        '"use client";\nimport { logThing } from "@/app/(app)/x/actions";\n' +
        "export default function ThingBar() {\n  return logThing(new FormData());\n}\n",
    });
    expect(unwiredPosters(root)).toEqual([
      "components/ThingBar.tsx posts logThing (app/(app)/x/actions.ts)",
    ]);
  });

  it("attributes a read to the RIGHT action when a file exports several", () => {
    // The failure this rules out is an off-by-one that blames a neighbour: a file
    // with a plain action above and a reading action below must name the second.
    const root = corpus({
      "app/(app)/x/actions.ts":
        '"use server";\nexport async function plainOne(fd: FormData) { return 1; }\n' +
        ACTION.replace('"use server";\n', ""),
      "components/ThingBar.tsx":
        '"use client";\nimport { plainOne } from "@/app/(app)/x/actions";\n',
    });
    // `plainOne` reads nothing, so importing it is not a finding.
    expect(unwiredPosters(root)).toEqual([]);
    expect([...readingActions(root).keys()]).toEqual(["logThing"]);
  });

  it("STAYS SILENT on the neighbours it must not cry wolf about", () => {
    // A guard that fired on a compliant client, on a server component, or on a file
    // that merely MENTIONS the symbol would be deleted within a week, taking the real
    // guard with it.
    const root = corpus({
      "app/(app)/x/actions.ts": ACTION,
      // Compliant three ways.
      "components/Stamped.tsx":
        '"use client";\nimport { logThing } from "@/app/(app)/x/actions";\n' +
        "import { useLoggedViaStamp } from '@/components/LoggedViaSurface';\n",
      "components/Fielded.tsx":
        '"use client";\nimport { logThing } from "@/app/(app)/x/actions";\n' +
        "import { LoggedViaField } from '@/components/LoggedViaSurface';\n",
      "components/Region.tsx":
        '"use client";\nimport { logThing } from "@/app/(app)/x/actions";\n' +
        "import { LoggedViaSurface } from '@/components/LoggedViaSurface';\n",
      // A SERVER component: it posts through an inline server action on the page it
      // IS, which is what `page` means. Not a mounting that can declare anything.
      "app/(app)/x/page.tsx":
        'import { logThing } from "@/app/(app)/x/actions";\n',
      // A client that only NAMES the symbol in prose.
      "components/Mentions.tsx":
        '"use client";\n// logThing is the action the bar over there posts.\n',
    });
    expect(unwiredPosters(root)).toEqual([]);
  });

  it("scans the TRACKED set it claims to be about", () => {
    const tracked = new Set(
      execFileSync("git", ["ls-files", "-z", "app", "components"], {
        cwd: REPO,
        maxBuffer: 64 * 1024 * 1024,
      })
        .toString("utf8")
        .split("\u0000")
        .filter(Boolean)
    );
    const untracked = [...walk(REPO, "app"), ...walk(REPO, "components")]
      .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
      .filter((rel) => !tracked.has(rel));
    expect(untracked).toEqual([]);
  });
});
