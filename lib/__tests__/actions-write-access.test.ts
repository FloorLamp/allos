import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Write-access enforcement scanner (issue #33). The mirror of the profile-scoping
// leak test: it reads the repo's own Server Actions as TEXT (no DB, no network,
// so it stays "pure" in the vitest sense), extracts every EXPORTED async function
// from `app/**/*actions.ts`, and fails the build if a mutating action forgets to
// gate itself.
//
// THE RULE: an exported Server Action is authorized to mutate a profile's data
// only if its body calls `requireWriteAccess()` (write-gated: admins pass, a
// read-only-granted member is bounced) OR `requireAdmin()` (admins are implicit
// all-write, so an admin-only action is inherently write-authorized). Everything
// else — reads, login-scoped prefs, session/auth entry points, and thin wrappers
// that delegate to a gated helper — must be on the SHORT allowlist below, each
// with a one-line justification. A NEW action that forgets the check matches
// neither and fails here, which is the entire point: enforcement can't silently
// regress as the surface grows.

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

// Allowlisted exported actions that legitimately do NOT call requireWriteAccess()
// / requireAdmin(), keyed by the file they live in (so an unrelated file can't
// ride the exemption) and the function name. Keep this list SHORT and justified.
//
// `gate` (issue #278): a login-scoped action that mutates the caller's LOGIN auth
// state (password, 2FA, sessions) must still refuse in demo mode — the shared
// public demo login would otherwise let one visitor lock everyone else out. Such
// an entry names the guard its body MUST call (requireLoginWriteAccess); the scan
// fails if the call disappears, so the demo gate can't silently regress back to a
// bare requireSession().
const ALLOW: { file: string; fn: string; why: string; gate?: string }[] = [
  // --- Read-only actions (return data, mutate nothing) ---
  {
    file: "app/(app)/data/actions.ts",
    fn: "getImportJobs",
    why: "read-only: lists the profile's import jobs for the review UI",
  },
  {
    file: "app/(app)/data/actions.ts",
    fn: "getImportJobStates",
    why: "read-only: status snapshot the client poller reads on an interval",
  },
  {
    file: "app/(app)/medical/document-actions.ts",
    fn: "getExtractionStates",
    why: "read-only: per-document extraction status snapshot",
  },
  {
    file: "app/(app)/search-actions.ts",
    fn: "runGlobalSearch",
    why: "read-only: cross-domain search of the active profile",
  },
  {
    file: "app/(app)/journal/actions.ts",
    fn: "loadJournalPage",
    why: "read-only: fetches an older window of the active profile's Journal feed for server-side paging (#451); `before` is a date cursor, not a profile selector",
  },
  // --- Login-scoped actions (operate on the LOGIN, not profile-owned data) ---
  {
    file: "app/(app)/settings/actions.ts",
    fn: "saveUnitPrefs",
    why: "login-scoped: unit display prefs keyed by login.id, not profile data",
  },
  {
    file: "app/(app)/settings/actions.ts",
    fn: "changeOwnPassword",
    why: "login-scoped: changes the caller's own password (demo-gated, #278)",
    gate: "requireLoginWriteAccess",
  },
  {
    file: "app/(app)/settings/actions.ts",
    fn: "revokeSessionAction",
    why: "login-scoped: revokes one of the caller's own sessions (demo-gated, #278)",
    gate: "requireLoginWriteAccess",
  },
  {
    file: "app/(app)/settings/actions.ts",
    fn: "signOutOtherSessions",
    why: "login-scoped: signs out the caller's other sessions (demo-gated, #278)",
    gate: "requireLoginWriteAccess",
  },
  {
    file: "app/(app)/settings/actions.ts",
    fn: "getPushPublicKey",
    why: "login-scoped: ensures the instance VAPID keypair exists (idempotent global bootstrap, like the auto-generated Telegram webhook secret) and returns only the PUBLIC key — never profile-owned data",
  },
  {
    file: "app/(app)/settings/actions.ts",
    fn: "savePushSubscriptionAction",
    why: "login-scoped: stores this browser's push subscription keyed by login.id (like a session), not profile-owned data",
  },
  {
    file: "app/(app)/settings/actions.ts",
    fn: "deletePushSubscriptionAction",
    why: "login-scoped: removes this browser's push subscription, scoped to the caller's login.id",
  },
  {
    file: "app/(app)/settings/actions.ts",
    fn: "sendTestPush",
    why: "login-scoped: sends a test push to the caller's own subscribed browsers",
  },
  {
    file: "app/(app)/settings/actions.ts",
    fn: "begin2fa",
    why: "login-scoped: starts 2FA enrollment for the caller's OWN login (mints a pending TOTP secret), not profile-owned data (demo-gated, #278)",
    gate: "requireLoginWriteAccess",
  },
  {
    file: "app/(app)/settings/actions.ts",
    fn: "activate2fa",
    why: "login-scoped: verifies a code and enables 2FA on the caller's OWN login (like change-own-password) (demo-gated, #278)",
    gate: "requireLoginWriteAccess",
  },
  {
    file: "app/(app)/settings/actions.ts",
    fn: "disable2fa",
    why: "login-scoped: turns 2FA off on the caller's OWN login after re-auth (password + code)",
  },
  {
    file: "app/(app)/settings/actions.ts",
    fn: "regenerate2faRecoveryCodes",
    why: "login-scoped: rotates the caller's OWN one-time recovery codes after a valid code",
  },
  {
    file: "app/(app)/integrations/calendar-feed/actions.ts",
    fn: "enableConsolidatedCalendarFeedAction",
    why: "login-scoped: mints the family .ics token keyed by login.id (like a push subscription); the feed only exposes appointments the login can already READ, so a read-only member may manage it",
  },
  {
    file: "app/(app)/integrations/calendar-feed/actions.ts",
    fn: "disableConsolidatedCalendarFeedAction",
    why: "login-scoped: revokes the caller's own family .ics token (login.id), not profile-owned data",
  },
  // --- Session / auth entry points (no profile-owned data mutation) ---
  {
    file: "app/(app)/user-actions.ts",
    fn: "logoutAction",
    why: "session teardown; touches only the session, no profile-owned data",
  },
  {
    file: "app/(app)/user-actions.ts",
    fn: "switchProfileAction",
    why: "moves the session's active-profile pointer (setActiveProfile re-checks accessibility); not a write to profile-owned data, and read-only members must still be able to switch profiles",
  },
  {
    file: "app/(auth)/login/actions.ts",
    fn: "login",
    why: "public auth entry point; runs before any session/profile exists",
  },
  {
    file: "app/(auth)/login/actions.ts",
    fn: "verifyLoginTotp",
    why: "public auth entry point (issue #23 second-factor step); completes a pre-session 2FA challenge, mints the session — no profile-owned data",
  },
  // --- Thin wrappers that delegate to a gated helper ---
  {
    file: "app/(app)/encounters/appointment-actions.ts",
    fn: "completeAppointment",
    why: "delegates to setStatus(), which calls requireWriteAccess()",
  },
  {
    file: "app/(app)/encounters/appointment-actions.ts",
    fn: "cancelAppointment",
    why: "delegates to setStatus(), which calls requireWriteAccess()",
  },
  {
    file: "app/(app)/encounters/appointment-actions.ts",
    fn: "reopenAppointment",
    why: "delegates to setStatus(), which calls requireWriteAccess()",
  },
  // --- Cross-profile / session-pointer actions (gate the TARGET, not the active
  // profile, so requireWriteAccess() would check the wrong profile) ---
  {
    file: "app/(app)/household/actions.ts",
    fn: "openProfileAction",
    why: "moves the session's active-profile pointer (setActiveProfile re-checks accessibility); not a write to profile-owned data, and read-only members must still be able to switch profiles",
  },
  {
    file: "app/(app)/household/actions.ts",
    fn: "confirmDoseAction",
    why: "acts on a NON-active target profile; gates via requireProfileWriteAccess(targetId), which asserts the target is accessible AND write — the active-profile requireWriteAccess() would authorize the wrong profile",
  },
];

function walk(dir: string, out: string[]) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue;
      walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
}

// Every Server-Action module: any file whose name ends in `actions.ts`
// (`actions.ts` and the `*-actions.ts` variants), minus tests.
function actionFiles(): string[] {
  const all: string[] = [];
  walk(path.join(REPO, "app"), all);
  return all.filter((f) => {
    if (!f.endsWith("actions.ts")) return false;
    if (f.endsWith(".test.ts")) return false;
    return true;
  });
}

// Strip comments so a stray mention of the guard name in prose can't satisfy the
// check — only a real call in code counts. Block comments first, then whole-line
// `//` comments (the only place these files park explanatory text). Leaves string
// literals intact; the token we scan for (`requireWriteAccess(`) never appears in
// a user-facing string.
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

// Extract every exported async function as { name, body }. Balanced-brace scan
// from the function's opening `{` to its matching `}`.
function exportedAsyncFunctions(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /export\s+async\s+function\s+([A-Za-z0-9_]+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const name = m[1];
    // Walk to the end of the parameter list, then to the body's opening brace.
    let i = m.index + m[0].length;
    let depth = 1; // we're just past the '('
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      i++;
    }
    // Skip a return-type annotation up to the body's opening '{', ignoring any
    // '{' nested inside a <...> generic — e.g. `: Promise<{ ok: true }>`, whose
    // object brace must NOT be mistaken for the function body.
    let angle = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === "<") angle++;
      else if (c === ">") {
        if (angle > 0) angle--;
      } else if (c === "{" && angle === 0) break;
      i++;
    }
    if (src[i] !== "{") continue;
    let bdepth = 1;
    let j = i + 1;
    let body = "";
    while (j < src.length && bdepth > 0) {
      const c = src[j];
      if (c === "{") bdepth++;
      else if (c === "}") {
        bdepth--;
        if (bdepth === 0) break;
      }
      body += c;
      j++;
    }
    out.push({ name, body });
    re.lastIndex = j + 1;
  }
  return out;
}

const GATE_RE = /\b(requireWriteAccess|requireAdmin)\s*\(/;

describe("write-access enforcement: every mutating Server Action is gated", () => {
  const files = actionFiles();

  it("scans a meaningful number of action files", () => {
    // Guards against a broken glob silently passing the whole suite.
    expect(files.length).toBeGreaterThan(25);
  });

  it("every exported action calls requireWriteAccess()/requireAdmin() or is allowlisted", () => {
    const violations: string[] = [];
    const matchedAllow = new Set<string>();
    let scanned = 0;

    for (const file of files) {
      const rel = path.relative(REPO, file).split(path.sep).join("/");
      const src = stripComments(fs.readFileSync(file, "utf8"));
      for (const { name, body } of exportedAsyncFunctions(src)) {
        scanned++;
        if (GATE_RE.test(body)) continue; // write-gated (or admin-gated)
        const allow = ALLOW.find((a) => a.file === rel && a.fn === name);
        if (allow) {
          matchedAllow.add(`${allow.file}#${allow.fn}`);
          // A demo-gated login-scoped mutation (#278) must actually call its
          // declared guard — the allowlist exemption alone is not enough.
          if (allow.gate && !new RegExp(`\\b${allow.gate}\\s*\\(`).test(body)) {
            violations.push(
              `${rel}#${name}: allowlisted with gate "${allow.gate}" but the body never calls it — the demo-mode guard regressed`
            );
          }
          continue;
        }
        violations.push(
          `${rel}#${name}: mutating action missing requireWriteAccess() — add the guard, or allowlist it with a justification if it is a read/login-scoped/admin/delegating action`
        );
      }
    }

    // The scan must actually see the whole action surface.
    expect(scanned).toBeGreaterThan(70);
    expect(violations, `\n${violations.join("\n")}\n`).toEqual([]);

    // No stale allowlist entries: every exemption must correspond to a real
    // exported action still present (a renamed/removed action must drop its entry
    // so the list can't rot into a silent hole).
    const stale = ALLOW.filter(
      (a) => !matchedAllow.has(`${a.file}#${a.fn}`)
    ).map((a) => `${a.file}#${a.fn}`);
    expect(stale, `stale allowlist entries: ${stale.join(", ")}`).toEqual([]);
  });
});
