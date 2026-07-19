import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Static guard for the date/time display-pref rollout (#964, finished by #1020) —
// the profile-scoping / telegram-chokepoint source-scan pattern applied to date
// rendering. It reads the repo's own production source as TEXT (no DB, no
// browser, so it stays "pure" in the vitest sense) and enforces two rules:
//
//   (i)  No implicit-locale Date formatting. `.toLocaleDateString(` /
//        `.toLocaleTimeString(` / `.toLocaleString(` render in the RUNTIME's
//        locale — on the server that's the host's locale (not even a stable
//        default), on the client the browser's, and both float free of the
//        login's date/time prefs. Every date render goes through the pref-aware
//        formatters in lib/format-date (or lib/record-format). Numeric
//        thousands-separator formatting is fine when the locale is pinned:
//        `.toLocaleString("en-US")` is allowed anywhere. The admin ops pages
//        (Active sessions, error/AI log tables, Settings → Server timestamps)
//        are grandfathered via the per-file count freeze below — an
//        acknowledged, admin-only status quo, explicitly out of #1020's scope.
//
//   (ii) No pref-less calls of the pref-taking date formatters. `formatLongDate`
//        and `formatMonthDay` take prefs as their 2nd argument,
//        `formatRecordDate`/`formatRecordDateTime` as their 3rd; the defaults
//        exist for the documented LOGIN-LESS channels (Telegram/push/HA sends,
//        the .ics feed — a profile but no login in context), not as an app-code
//        convenience. A call that omits the prefs argument silently pins the
//        viewer to the fixed default shape — the exact ~95-site rot #1020
//        cleaned up. Login-less channel modules are allowlisted by file below.
//
// Both allowlists are per-file COUNT freezes (the e2e-hygiene model): an entry
// only ever shrinks — going below the frozen count fails with a message to lower
// it here in the same PR, so the lists can't silently go stale; a NEW occurrence
// (count above frozen, or a new file) fails the build.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Production source only — the test tiers legitimately exercise/assert on the
// raw formatter behaviors.
const SCAN_DIRS = ["app", "components", "lib"];

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
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      out.push(...walk(full));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(): { rel: string; text: string }[] {
  const files: { rel: string; text: string }[] = [];
  for (const d of SCAN_DIRS) {
    const abs = path.join(REPO, d);
    if (!fs.existsSync(abs)) continue;
    for (const full of walk(abs)) {
      const rel = path.relative(REPO, full).replace(/\\/g, "/");
      if (isExcluded(rel)) continue;
      files.push({ rel, text: fs.readFileSync(full, "utf8") });
    }
  }
  return files;
}

// ---- Rule (i): implicit-locale toLocale* calls -----------------------------

// Frozen admin-ops offenders as of #1020 (per-file `.toLocale*(` call counts,
// after excluding the pinned-locale `.toLocaleString("en-US")` form). Migrating
// one to the pref-aware formatters LOWERS its number here in the same PR; a
// fully-migrated file drops out entirely. New files must not appear.
const TOLOCALE_ALLOWLIST: Record<string, number> = {
  // Admin-only session list ("Last seen" timestamps).
  "app/(app)/settings/ActiveSessions.tsx": 1,
  // Admin-only error log table timestamps.
  "app/(app)/settings/errors/ErrorLogTable.tsx": 1,
  // Admin-only AI log stream: one timestamp + two token-usage counters.
  "app/(app)/settings/logs/LogsStream.tsx": 3,
  // Admin-only AI usage rollup counter.
  "app/(app)/settings/logs/UsageRollup.tsx": 1,
  // Admin-only delivery-error timestamp on Settings → Notifications.
  "app/(app)/settings/notifications/ServerTelegramSettings.tsx": 1,
  // Admin-only Settings → Server status timestamps (backup/integrity).
  "app/(app)/settings/server/page.tsx": 3,
};

// A `.toLocale…(` CALL (leading dot keeps prose mentions in comments out);
// `.toLocaleString("en-US"` (pinned-locale numeric formatting) is allowed.
const TOLOCALE_RE = /\.toLocale(?:Date|Time)?String\((?!\s*["']en-US["'])/g;

function countMatches(text: string, re: RegExp): number {
  return [...text.matchAll(re)].length;
}

// ---- Rule (ii): pref-less pref-taking formatter calls ----------------------

// Formatter → the argument position (1-based count) its prefs parameter holds.
const FORMATTER_MIN_ARGS: Record<string, number> = {
  formatLongDate: 2,
  formatMonthDay: 2,
  formatRecordDate: 3,
  formatRecordDateTime: 3,
};

// Login-less channels (documented fixed-format policy — see lib/format-date.ts's
// header): these files render into a channel with a profile but NO login in
// context, so the fixed default IS the correct shape, deliberately.
const PREFLESS_ALLOWLIST: Record<string, number> = {
  // Telegram callback answers ("Snoozed until …") — fixed Telegram channel shape.
  "lib/notifications/callback-data.ts": 2,
};

// Count top-level arguments of the call starting at `open` (index of "(").
// Paren/bracket/brace balancing spans newlines; good enough for source scanning
// (string literals containing unbalanced brackets would be pathological here).
function callArgCount(text: string, open: number): number {
  let depth = 0;
  let args = 0;
  let sawContent = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return sawContent ? args + 1 : 0;
    } else if (ch === "," && depth === 1) args++;
    else if (depth >= 1 && !/\s/.test(ch)) sawContent = true;
  }
  return sawContent ? args + 1 : 0;
}

function preflessCalls(text: string): { name: string; index: number }[] {
  const out: { name: string; index: number }[] = [];
  for (const [name, minArgs] of Object.entries(FORMATTER_MIN_ARGS)) {
    const re = new RegExp(`\\b${name}\\(`, "g");
    for (const m of text.matchAll(re)) {
      // Skip the definition itself (`function formatLongDate(`).
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      if (/function\s+$/.test(before)) continue;
      const argc = callArgCount(text, m.index + name.length);
      if (argc < minArgs) out.push({ name, index: m.index });
    }
  }
  return out;
}

function lineOf(text: string, index: number): number {
  return text.slice(0, index).split("\n").length;
}

describe("date/time display-pref guard (#964/#1020)", () => {
  it("no implicit-locale toLocale* date/time calls outside the frozen admin-ops allowlist", () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const { rel, text } of sourceFiles()) {
      const count = countMatches(text, TOLOCALE_RE);
      if (count === 0) continue;
      seen.add(rel);
      const allowed = TOLOCALE_ALLOWLIST[rel] ?? 0;
      if (count > allowed) {
        problems.push(
          `${rel}: ${count} \`.toLocale*(\` call(s), allowed ${allowed}. ` +
            `Use the pref-aware formatters in lib/format-date (formatDateShape/` +
            `formatClock/formatLongDate/…) — or .toLocaleString("en-US") for ` +
            `numeric thousands separators.`
        );
      } else if (count < allowed) {
        problems.push(
          `${rel}: ${count} \`.toLocale*(\` call(s), allowlist froze ${allowed}. ` +
            `Lower its entry in TOLOCALE_ALLOWLIST to ${count} in this PR (the ` +
            `list only shrinks).`
        );
      }
    }
    for (const rel of Object.keys(TOLOCALE_ALLOWLIST)) {
      if (!seen.has(rel)) {
        problems.push(
          `${rel} is in TOLOCALE_ALLOWLIST but has no matches (or no longer ` +
            `exists) — remove its entry (the list only shrinks).`
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });

  it("every pref-taking date-formatter call passes prefs, outside the login-less allowlist", () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    for (const { rel, text } of sourceFiles()) {
      const calls = preflessCalls(text);
      if (calls.length === 0) continue;
      seen.add(rel);
      const allowed = PREFLESS_ALLOWLIST[rel] ?? 0;
      if (calls.length > allowed) {
        problems.push(
          `${rel}: pref-less formatter call(s) ` +
            calls
              .map((c) => `${c.name}(…) at line ${lineOf(text, c.index)}`)
              .join(", ") +
            ` (allowed ${allowed}). Thread DisplayFormatPrefs — client ` +
            `components via useFormatPrefs(), server components via ` +
            `getDisplayFormatPrefs(login.id) at the page boundary. Only a ` +
            `documented login-less channel may rely on the fixed default ` +
            `(add it to PREFLESS_ALLOWLIST with a comment).`
        );
      } else if (calls.length < allowed) {
        problems.push(
          `${rel}: ${calls.length} pref-less formatter call(s), allowlist ` +
            `froze ${allowed}. Lower its entry in PREFLESS_ALLOWLIST to ` +
            `${calls.length} in this PR (the list only shrinks).`
        );
      }
    }
    for (const rel of Object.keys(PREFLESS_ALLOWLIST)) {
      if (!seen.has(rel)) {
        problems.push(
          `${rel} is in PREFLESS_ALLOWLIST but has no pref-less calls (or no ` +
            `longer exists) — remove its entry (the list only shrinks).`
        );
      }
    }
    expect(problems, problems.join("\n")).toEqual([]);
  });
});
