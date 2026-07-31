import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static boundary guard for the app-icon badge (issue #1424, section B), in the
// shape of the Telegram chokepoint guard (#454): it reads the repo's own source
// as TEXT (no DB, no network, so it stays "pure" in the vitest sense).
//
// What it protects. The badge count is the care-tier "Needs attention" number
// the dashboard hero ALREADY computed — `attentionCardItems(items, today).length`
// over `collectAttentionModel` (#449). The issue's whole test note is that there
// is no second computation to test, only a guard that "the badge call sites read
// the shared model, not a re-query". This is that guard, in three parts:
//
//   1. The Badging API is called from ONE module. A second call site is a second
//      opinion about what the icon should say.
//   2. That module derives nothing — it imports no query/attention layer, so the
//      count can only have arrived as a prop.
//   3. Its only mount is the hero, which is where the shared count lives. A
//      badge mounted anywhere else would be reading some OTHER number (the
//      nav's `reviewCount` is a different set entirely) or forcing a new query.
//
// Failing this test is not a style complaint: it means the home-screen icon and
// the dashboard can now disagree, which is the #221 hand-mirrored-second-engine
// disease at the platform boundary.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// The Badging API surface. Feature-detected in the chokepoint; called nowhere else.
const BADGE_CALLS = ["setAppBadge", "clearAppBadge"];

const CHOKEPOINT = "components/AppBadge.tsx";
// The one mount: the component that owns the shared count.
const MOUNT = "components/dashboard/NeedsAttentionHero.tsx";

const SCAN_DIRS = ["lib", "app", "components", "scripts"];

function isExcluded(rel: string): boolean {
  return (
    rel.includes("__tests__") ||
    rel.includes("__db_tests__") ||
    rel.includes("__action_tests__") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx")
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const FILES = SCAN_DIRS.flatMap((d) => walk(path.join(REPO, d)))
  .map((f) => path.relative(REPO, f))
  .filter((f) => !isExcluded(f))
  .sort();

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// Comments are PROSE, and this guard is about CODE. The modules here necessarily
// explain themselves in terms of the very identifiers being guarded ("the count
// is attentionCardItems(...).length", "setAppBadge(0) shows a dot") — matching
// those would make the guard fire on its own documentation and, worse, pressure
// the next author to delete the explanation to get CI green. Naive but adequate:
// this only ever feeds a substring scan.
function code(rel: string): string {
  return read(rel)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("app-badge chokepoint", () => {
  it("the scan actually sees source (guards against a silently empty walk)", () => {
    expect(FILES.length).toBeGreaterThan(200);
    expect(FILES).toContain(CHOKEPOINT);
    expect(FILES).toContain(MOUNT);
  });

  it("only the chokepoint calls the Badging API", () => {
    const offenders = FILES.filter(
      (f) => f !== CHOKEPOINT && BADGE_CALLS.some((c) => code(f).includes(c))
    );
    expect(
      offenders,
      `The app-icon badge is set from ${CHOKEPOINT} only. A second call site is a ` +
        `second opinion about what the icon says — route the count to <AppBadge> instead.`
    ).toEqual([]);
  });

  it("the chokepoint feature-detects rather than assuming the API exists", () => {
    const src = read(CHOKEPOINT);
    // Optional-call form: absent API (Firefox, iOS Safari) must be a silent no-op.
    expect(src).toContain("setAppBadge?.(");
    expect(src).toContain("clearAppBadge?.(");
  });

  it("the chokepoint re-derives nothing — the count can only be a prop", () => {
    const src = code(CHOKEPOINT);
    const forbidden = [
      "collectAttentionModel",
      "attentionCardItems",
      "attentionCountForProfile",
      "attentionHeroState",
      "collectUpcoming",
      "collectCoachingFindings",
      "@/lib/queries",
      "@/lib/attention",
      "@/lib/upcoming",
      "@/lib/db",
      "fetch(",
    ];
    const found = forbidden.filter((f) => src.includes(f));
    expect(
      found,
      `${CHOKEPOINT} must be a FORMATTER over the hero's already-computed count. ` +
        `Re-querying here forks the #449 care-tier set into two answers.`
    ).toEqual([]);
  });

  it("the badge is mounted only by the component that owns the shared count", () => {
    const importers = FILES.filter(
      (f) =>
        f !== CHOKEPOINT &&
        /from\s+["']@\/components\/AppBadge["']/.test(code(f))
    );
    expect(
      importers,
      `<AppBadge> belongs to ${MOUNT}, whose \`count\` IS attentionCardItems(...).length. ` +
        `Mounting it elsewhere means badging some other number (the nav's reviewCount is a ` +
        `different set) or adding a query to do it.`
    ).toEqual([MOUNT]);
  });

  it("the mount passes the SAME local the hero's visible badge uses", () => {
    const src = code(MOUNT);
    expect(src).toContain(
      "const count = attentionCardItems(items, today).length"
    );
    // Both branches — including all-clear, where the badge must CLEAR. Without
    // the zero mount a resolved user keeps a stale number on their home screen.
    const mounts = src.match(/<AppBadge count=\{count\} \/>/g) ?? [];
    expect(
      mounts.length,
      `<AppBadge count={count} /> must appear on BOTH hero branches: the card ` +
        `branch to SET the badge and the all-clear branch to CLEAR it.`
    ).toBe(2);
  });
});
