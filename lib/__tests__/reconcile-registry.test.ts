// THE COMPLETENESS GUARD (issue #1779 §3).
//
// The defect this feature fixes was not one broken button family — it was that NOBODY
// had been asked, per family, "what happens when this message is still sitting in the
// chat tomorrow?". Fixing the families that exist today without freezing that question
// into the build would just re-open the hole at the next button.
//
// So this test reads the notification source as TEXT (the house pattern —
// profile-scoping, phi-scan and the Telegram chokepoint guard all work this way; no DB,
// no network, so it stays in the pure tier), extracts every callback-token prefix the
// app can actually mint, and fails the build unless each one is either
//
//   • owned by a reconciler family, or
//   • declared INERT with a written reason.
//
// It also fails on a STALE registry entry, so a retired button family cannot leave a
// reconciler behind claiming to cover something that no longer ships.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  KIND_REISSUE,
  RECONCILE_PREFIXES,
  inertTokens,
  isReissuableKind,
  owningFamily,
  reconcileEntryFor,
} from "@/lib/notifications/reconcile-registry";
import { tokenPrefix } from "@/lib/notifications/reconcile-core";
import { ALL_NOTIFICATION_KINDS } from "@/lib/notifications/kinds";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const NOTIFY_DIR = path.join(REPO, "lib/notifications");

function productionSources(): { rel: string; text: string }[] {
  return fs
    .readdirSync(NOTIFY_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({
      rel: `lib/notifications/${f}`,
      text: fs.readFileSync(path.join(NOTIFY_DIR, f), "utf8"),
    }));
}

// Strip comments so a prose mention of a token shape in a header comment is not read as
// a minted prefix (every module here documents its token format in prose).
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");
}

// The prefixes the app can actually put on a button, harvested three ways because the
// codebase mints tokens three ways:
//
//   1. a literal in an action's `data:` field           — data: `pvdone:${id}:${key}`
//   2. a literal in a parser's prefix test              — data.startsWith("hh:")
//   3. a shared token BUILDER's return                  — return `food:${profileId}:…`
//   4. a regex-literal prefix test                      — /^foodprotein:(\d+):/
//   5. a template whose head is a local PREFIX constant — `${OFFER_EXPAND_PREFIX}:${…}`
//
// (5) is resolved against `const NAME = "value"` in the SAME file, which is where the
// offer-tail and ⚙️ Tune namespaces live.
function mintedPrefixes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const note = (prefix: string, rel: string) => {
    const at = found.get(prefix);
    if (at) {
      if (!at.includes(rel)) at.push(rel);
    } else found.set(prefix, [rel]);
  };

  for (const { rel, text } of productionSources()) {
    const src = stripComments(text);

    // Local `const NAME = "value";` table, for the template-head case.
    const consts = new Map<string, string>();
    for (const m of src.matchAll(
      /(?:export\s+)?const\s+(\w+)\s*=\s*"([a-z][a-z0-9]*)"\s*;/g
    )) {
      consts.set(m[1], m[2]);
    }

    // 1. data: `xxx:…` / data: "xxx:…"
    for (const m of src.matchAll(/data:\s*[`"']([a-z][a-z0-9]*):/g)) {
      note(m[1], rel);
    }
    // 2. startsWith("xxx:")
    for (const m of src.matchAll(/startsWith\(\s*"([a-z][a-z0-9]*):"\s*\)/g)) {
      note(m[1], rel);
    }
    // 3. return `xxx:${…}` — the shared token builders (food, household round).
    for (const m of src.matchAll(/return\s+`([a-z][a-z0-9]*):\$\{/g)) {
      note(m[1], rel);
    }
    // 4. /^xxx:…/ — a parser that tests its prefix inside a regex literal.
    for (const m of src.matchAll(/\/\^([a-z][a-z0-9]*):/g)) {
      note(m[1], rel);
    }
    // 5. data: `${NAME}:…`  and  return `${NAME}:…`
    for (const m of src.matchAll(
      /(?:data:\s*|return\s+)`\$\{([A-Z_][A-Z0-9_]*)\}:/g
    )) {
      const value = consts.get(m[1]);
      if (value) note(value, rel);
    }
  }
  return found;
}

describe("the callback-vocabulary completeness guard (#1779)", () => {
  const minted = mintedPrefixes();

  it("the scan actually finds the vocabulary (it would pass vacuously otherwise)", () => {
    // A sample from three different modules and all three mint styles, so a regex that
    // silently stops matching fails here rather than turning the guard into a no-op.
    for (const known of ["take", "hh", "pvdone", "food", "offer", "tunet"]) {
      expect(minted.has(known), `scan missed the "${known}:" prefix`).toBe(
        true
      );
    }
    expect(minted.size).toBeGreaterThan(20);
  });

  it("every callback prefix the app can mint has a reconciler or a written INERT reason", () => {
    const unanswered: string[] = [];
    for (const [prefix, files] of minted) {
      const entry = reconcileEntryFor(prefix);
      if (!entry) {
        unanswered.push(
          `"${prefix}:" (${files.join(", ")}) — add it to RECONCILE_PREFIXES with a ` +
            `family, or declare it inert with the reason it cannot go stale`
        );
        continue;
      }
      if (!entry.family && !entry.inert) {
        unanswered.push(
          `"${prefix}:" has an entry but neither a family nor a reason`
        );
      }
    }
    expect(unanswered, `\n${unanswered.join("\n")}\n`).toEqual([]);
  });

  it("no STALE registry entry — every declared prefix is still minted somewhere", () => {
    const stale = RECONCILE_PREFIXES.filter((e) => !minted.has(e.prefix)).map(
      (e) => e.prefix
    );
    expect(
      stale,
      `retired prefixes still in the registry: ${stale.join(", ")}`
    ).toEqual([]);
  });

  it("every inert declaration carries a real reason, not a placeholder", () => {
    for (const e of RECONCILE_PREFIXES) {
      if (!e.inert) continue;
      expect(
        e.inert.length,
        `"${e.prefix}" needs a real reason`
      ).toBeGreaterThan(30);
    }
  });

  it("an entry declares exactly one of family / inert", () => {
    for (const e of RECONCILE_PREFIXES) {
      expect(
        Boolean(e.family) !== Boolean(e.inert),
        `"${e.prefix}" must be owned OR inert, not both and not neither`
      ).toBe(true);
    }
  });

  it("no duplicate prefixes", () => {
    const seen = new Set<string>();
    for (const e of RECONCILE_PREFIXES) {
      expect(seen.has(e.prefix), `duplicate entry for "${e.prefix}"`).toBe(
        false
      );
      seen.add(e.prefix);
    }
  });
});

// THE SECOND COMPLETENESS GUARD (issue #1898). The prefix table above asks "what
// happens when this BUTTON is still in the chat tomorrow?". This one asks, per KIND,
// "does sending this again replace the last one, or add to it?" — the question nobody
// had been asked, which is why `/dose` and `/symptom` accumulated live keyboards.
describe("the re-issue completeness guard (#1898)", () => {
  it("every notification kind declares whether it is re-issuable", () => {
    const declared = new Set(KIND_REISSUE.map((e) => e.kind as string));
    const undeclared = ALL_NOTIFICATION_KINDS.filter((k) => !declared.has(k));
    expect(
      undeclared,
      `kinds with no re-issue declaration: ${undeclared.join(", ")} — add a ` +
        `KIND_REISSUE entry saying whether a new send of this kind supersedes the ` +
        `chat's previous one, and why`
    ).toEqual([]);
  });

  it("no STALE declaration — every declared kind is still a real kind", () => {
    const known = new Set<string>(ALL_NOTIFICATION_KINDS);
    const stale = KIND_REISSUE.filter((e) => !known.has(e.kind)).map(
      (e) => e.kind
    );
    expect(stale, `retired kinds still declared: ${stale.join(", ")}`).toEqual(
      []
    );
  });

  it("both answers carry a real reason — including the 'yes'", () => {
    for (const e of KIND_REISSUE) {
      expect(e.why.length, `${e.kind} needs a real reason`).toBeGreaterThan(40);
    }
  });

  it("no duplicate kinds", () => {
    const seen = new Set<string>();
    for (const e of KIND_REISSUE) {
      expect(seen.has(e.kind), `duplicate declaration for "${e.kind}"`).toBe(
        false
      );
      seen.add(e.kind);
    }
  });

  it("the catch-all kind is never re-issuable", () => {
    // Every un-kinded send lands in "other". If it superseded, any two unrelated
    // messages in one chat would close each other.
    expect(isReissuableKind("other")).toBe(false);
    expect(isReissuableKind(undefined)).toBe(false);
    expect(isReissuableKind(null)).toBe(false);
  });

  it("an UNKNOWN kind fails safe — it closes nothing", () => {
    expect(isReissuableKind("kind-nobody-declared")).toBe(false);
  });

  it("no SAFETY kind is re-issuable", () => {
    // A dose reminder and a missed-dose escalation each assert an outstanding claim.
    // Superseding one because another sent would remove a prompt nobody answered.
    for (const kind of ["dose", "escalation", "redose"]) {
      expect(isReissuableKind(kind), `${kind} must not supersede`).toBe(false);
    }
  });

  it("the on-demand command kinds ARE re-issuable", () => {
    expect(isReissuableKind("prn-list")).toBe(true);
    expect(isReissuableKind("symptom")).toBe(true);
  });
});

describe("owningFamily / inertTokens", () => {
  const DATE = "2020-03-04";

  it("the owner is the FIRST state-claiming token — ride-alongs never win", () => {
    // A dose reminder carries its take/skip rows first and the offer tail last, so the
    // dose family owns the message even though the tail is also on it.
    expect(
      owningFamily([`take:7:11:3:${DATE}`, `offer:7:${DATE}`], tokenPrefix)
    ).toBe("intake-dose");
  });

  it("a keyboard of pure view controls has no owner — nothing to reconcile", () => {
    expect(
      owningFamily([`offer:7:${DATE}`, `tune:7:${DATE}`], tokenPrefix)
    ).toBeNull();
  });

  it("an unknown prefix is NOT treated as inert — an unreasoned button fails safe", () => {
    expect(inertTokens(["mystery:1:2"], tokenPrefix).size).toBe(0);
    expect(owningFamily(["mystery:1:2"], tokenPrefix)).toBeNull();
  });

  it("inert tokens are picked out by their registry declaration", () => {
    expect([
      ...inertTokens([`tune:7:${DATE}`, `take:7:1:1:${DATE}`], tokenPrefix),
    ]).toEqual([`tune:7:${DATE}`]);
  });
});
