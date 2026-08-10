import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Every authenticated page renders the SHARED <PageHeader> (issue #1416, section
// D). A static source scan — it reads the repo's own TSX as TEXT (no DB, no
// network), so it stays "pure" in the vitest sense.
//
// Why it exists: headings had drifted into three treatments — PageHeader on ~46
// pages, hand-rolled `<h1 className="text-xl font-semibold">` on a handful, and
// nothing at all on a couple — which meant the mobile density pass (the compact
// `text-xl` + halved margin PageHeader now carries) could not be made in ONE
// place. This test is the ratchet: a new page that hand-rolls its heading fails
// CI instead of quietly re-opening the sweep.
//
// A page "renders PageHeader" transitively: directly, through any component it
// imports (a page whose title lives in a client workspace component — the
// Medications page's add-workspace, the protocol detail's controls — counts), or
// through an ancestor `layout.tsx` that draws the section header for its whole
// subtree (the /records and /results tab shells). That mirrors what a viewer
// sees, which is the thing being pinned.

// …and no page draws a SECOND heading at that same scale (issue #1449). The
// natural extension of the rule above: if PageHeader is the page's heading, then
// nothing below it may compete with it. Records › Care › Overview was the case
// that forced this — five `text-2xl font-bold` headings on one scroll (the page
// h1 plus Background / Family history / Care plan / Health goals), all identical
// weight, so nothing told you which one named the page; Problems had the same
// shape with Conditions/Allergies, and the Passport's "Emergency Card" section a
// third instance. Section headings now sit a rung below (`text-lg font-semibold`),
// giving one hierarchy: PageHeader h1 → section h2 → card h3.
const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const APP_GROUP = path.join(REPO, "app", "(app)");
const COMPONENTS = path.join(REPO, "components");

// Pages with a deliberate reason to carry no app page heading. Each entry is a
// JUSTIFIED exemption, not a backlog — a new page does not get to join this list
// without one.
const EXEMPT: Record<string, string> = {
  "medications/print/page.tsx":
    "A print artifact (#852): it renders the medication list exactly as it prints, with no app chrome — a page heading would print on the sheet handed to a clinician.",
  "immunizations/print/page.tsx":
    "A print artifact (#1849), on the medications/print precedent: it renders the immunization record exactly as it prints, with no app chrome — a page heading would print on the sheet handed to a registrar.",
  "medical/episodes/[id]/page.tsx":
    "The episode detail is a single <EpisodeSummary> card whose own header carries the episode's identity banner (#1373 cross-profile subject stamping); a second heading above it would name the same thing twice.",
  "page.tsx":
    "The dashboard: #1413 drops its header on mobile entirely (the Now strip leads), so it must not be pinned to one here.",
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name === "page.tsx") out.push(full);
  }
  return out;
}

// Resolve an import specifier (`@/…` or a relative path) to a file in the repo.
function resolveImport(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(REPO, spec.slice(2));
  else if (spec.startsWith("."))
    base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const candidate of [
    `${base}.tsx`,
    `${base}.ts`,
    path.join(base, "index.tsx"),
  ]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

const IMPORT_RE = /from\s+"([^"]+)"/g;

function rendersPageHeader(
  file: string,
  seen: Set<string> = new Set(),
  depth = 0
): boolean {
  // Depth 5 comfortably covers page → container → workspace → header while
  // keeping the scan cheap; nothing in the tree needs more.
  if (depth > 5 || seen.has(file)) return false;
  seen.add(file);
  const source = fs.readFileSync(file, "utf8");
  if (source.includes("PageHeader")) return true;
  for (const match of source.matchAll(IMPORT_RE)) {
    const resolved = resolveImport(match[1], file);
    if (resolved && rendersPageHeader(resolved, seen, depth + 1)) return true;
  }
  return false;
}

// A route that only forwards elsewhere (a consolidation's kept-alive old URL)
// renders nothing at all.
function isRedirect(source: string): boolean {
  return /\b(permanentRedirect|redirect)\s*\(/.test(source);
}

// The layout.tsx files between a page and the (app) group root, nearest first.
function ancestorLayouts(pageFile: string): string[] {
  const out: string[] = [];
  let dir = path.dirname(pageFile);
  while (dir.startsWith(APP_GROUP)) {
    const layout = path.join(dir, "layout.tsx");
    if (fs.existsSync(layout)) out.push(layout);
    if (dir === APP_GROUP) break;
    dir = path.dirname(dir);
  }
  // The (app) shell layout itself draws no page heading; skip it so a page can't
  // pass by accident if that ever changes.
  return out.filter((l) => l !== path.join(APP_GROUP, "layout.tsx"));
}

const PAGES = walk(APP_GROUP).sort();

describe("every (app) page renders the shared PageHeader", () => {
  it("finds the app's pages (the scan itself is wired up)", () => {
    expect(PAGES.length).toBeGreaterThan(50);
  });

  it("has no page with a hand-rolled or missing heading", () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
      const rel = path.relative(APP_GROUP, page).split(path.sep).join("/");
      if (rel in EXEMPT) continue;
      const source = fs.readFileSync(page, "utf8");
      if (isRedirect(source)) continue;
      if (rendersPageHeader(page)) continue;
      if (ancestorLayouts(page).some((l) => rendersPageHeader(l))) continue;
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
    // Reads every (app) page plus each one's ancestor layouts from disk. That fits
    // the default 5s budget on Linux CI but not on a Windows filesystem, where the
    // per-file stat/read overhead is enough to overrun it.
  }, 30_000);

  it("keeps the exemption list honest (every entry still exists)", () => {
    for (const rel of Object.keys(EXEMPT)) {
      expect(fs.existsSync(path.join(APP_GROUP, rel))).toBe(true);
    }
  });

  it("gives every exemption a written justification", () => {
    for (const [rel, why] of Object.entries(EXEMPT)) {
      expect(why.length, `${rel} needs a real reason`).toBeGreaterThan(40);
    }
  });
});

// `text-2xl font-bold` is the page-title treatment PageHeader draws. On a NUMBER
// (a stat tile, a dose count) it's just type; on a HEADING TAG it claims "I name
// this page", which only the page's one h1 may do.
const H1_SCALE = /<h[1-6][^>]*text-2xl font-bold/;

// Heading tags that legitimately carry page scale because they ARE their surface's
// page title. Same discipline as EXEMPT above: a written reason, not a backlog.
const H1_SCALE_OK: Record<string, string> = {
  "app/(app)/onboarding/page.tsx":
    "The onboarding flow's own title. It runs as a standalone first-run surface with no PageHeader above it, so this h1 IS the page heading rather than a section competing with one.",
  "components/ProfilePassport.tsx":
    "The passport artifact's own title (the person's name). It is the page heading in the standalone /share and print renders, where no app chrome exists; on /profile it reads as the artifact's masthead, not a section heading.",
};

function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTsx(full));
    else if (entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("only the page's own h1 uses the page-title heading scale (#1449)", () => {
  const FILES = [...walkTsx(APP_GROUP), ...walkTsx(COMPONENTS)].sort();

  it("finds the app's components (the scan itself is wired up)", () => {
    expect(FILES.length).toBeGreaterThan(100);
  });

  it("has no section heading competing with the page title", () => {
    const offenders = FILES.filter((f) =>
      H1_SCALE.test(fs.readFileSync(f, "utf8"))
    )
      .map((f) => path.relative(REPO, f).split(path.sep).join("/"))
      .filter((rel) => !(rel in H1_SCALE_OK));
    expect(offenders).toEqual([]);
  });

  it("keeps the page-scale allowlist honest (every entry still exists and still qualifies)", () => {
    for (const rel of Object.keys(H1_SCALE_OK)) {
      const full = path.join(REPO, rel);
      expect(fs.existsSync(full), `${rel} no longer exists`).toBe(true);
      // If the file stopped using page scale, drop it from the list rather than
      // leaving a stale exemption that would silently cover a future regression.
      expect(H1_SCALE.test(fs.readFileSync(full, "utf8")), rel).toBe(true);
    }
  });

  it("gives every page-scale allowance a written justification", () => {
    for (const [rel, why] of Object.entries(H1_SCALE_OK)) {
      expect(why.length, `${rel} needs a real reason`).toBeGreaterThan(40);
    }
  });
});
