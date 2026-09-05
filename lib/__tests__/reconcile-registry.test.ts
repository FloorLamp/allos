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
  HOST_INHERITED,
  KIND_PROSE,
  KIND_REISSUE,
  RECONCILE_DATE_GUARD,
  RECONCILE_PREFIXES,
  hasHostInheritedToken,
  inertTokens,
  keyboardFamilyValid,
  isReissuableKind,
  messageExpiry,
  owningFamily,
  proseReconcilerFor,
  reconcileEntryFor,
  type ReconcileFamily,
} from "@/lib/notifications/reconcile-registry";
import { tokenPrefix } from "@/lib/notifications/reconcile-core";
import { tapDateGuard } from "@/lib/notifications/callback-data";
import {
  DOSE_LOG_DATE_WINDOW_DAYS,
  isDoseDateAccepted,
} from "@/lib/dose-log-window";
import { shiftDateStr } from "@/lib/date";
import { ALL_NOTIFICATION_KINDS } from "@/lib/notifications/kinds";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const NOTIFY_DIR = path.join(REPO, "lib/notifications");

// ONE MINT SITE LIVES OUTSIDE lib/notifications, AND THAT WAS A HOLE (#4544). The digest
// time suggestion's three exits are built in lib/digest-time-suggestion.ts — the module
// that OWNS the suggestion, which is the right home for them — so this scan, which reads
// one directory, could not see them and the registry did not carry them. Found by typing
// the dispatch table against the registry rather than by any wider sweep; named here so
// the scan covers them from now on. Rule (5) resolves them: the file declares each prefix
// as a same-file `const` and builds the token from `${NAME}:`.
const EXTRA_MINT_SOURCES = ["lib/digest-time-suggestion.ts"];

function productionSources(): { rel: string; text: string }[] {
  return fs
    .readdirSync(NOTIFY_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => ({
      rel: `lib/notifications/${f}`,
      text: fs.readFileSync(path.join(NOTIFY_DIR, f), "utf8"),
    }))
    .concat(
      EXTRA_MINT_SOURCES.map((rel) => ({
        rel,
        text: fs.readFileSync(path.join(REPO, rel), "utf8"),
      }))
    );
}

// Strip comments so a prose mention of a token shape in a header comment is not read as
// a minted prefix (every module here documents its token format in prose).
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");
}

// The prefixes the app can actually put on a button, harvested by targeted rules for
// each token-minting shape in the notification modules:
//
//   1. a literal in an action's `data:` field           — data: `pvdone:${id}:${key}`
//   2. a literal in a parser's prefix test              — data.startsWith("hh:")
//   3. a shared token BUILDER's return                  — return `food:${profileId}:…`
//   4. a regex-literal prefix test                      — /^foodprotein:(\d+):/
//   5. a template whose head is a local PREFIX constant — `${OFFER_EXPAND_PREFIX}:${…}`
//   6. a shared correction-prefix declaration           — { chip: "foodtime", at: … }
//   7. the shared offer-builder prefix union             — type OfferPrefix = "usual" | …
//   8. the imported medication-stop prefix declaration  — MED_STOP_PREFIX = "medstop"
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
    // 6. `{ chip: "xxx", at: "yyy" }` — the time-correction families (#2019/#2020).
    // Their tokens are minted by ONE shared builder parameterised by the domain's
    // prefix pair, so the mint site carries no literal; the DECLARATION is where the
    // vocabulary is stated, and that is what this reads.
    for (const m of src.matchAll(/\b(?:chip|at):\s*"([a-z][a-z0-9]*)"/g)) {
      note(m[1], rel);
    }
    // 7. `type OfferPrefix = "usual" | "stacktake";` — the offer tokens (#2460, joined
    // by `stacktake:` in #3282) share ONE builder parameterised by the prefix, so the
    // mint site carries no literal. Same situation as (6), same answer: the union type
    // IS where the vocabulary is declared.
    for (const m of src.matchAll(/type OfferPrefix\s*=\s*([^;]+);/g)) {
      for (const lit of m[1].matchAll(/"([a-z][a-z0-9]*)"/g)) note(lit[1], rel);
    }
    // 8. `MED_STOP_PREFIX` is declared in the token leaf (`callback-tokens.ts`, #2961
    // step 1) and imported by both the parser and the dose-row renderer, so rule (5)'s
    // deliberately same-file lookup cannot resolve it. Read this one declaration rather
    // than broadening the source scanner. The scan walks every file in lib/notifications,
    // so moving the declaration between files in that directory does not move this rule.
    for (const m of src.matchAll(
      /const MED_STOP_PREFIX\s*=\s*"([a-z][a-z0-9]*)"\s*;/g
    )) {
      note(m[1], rel);
    }
  }
  return found;
}

describe("the callback-vocabulary completeness guard (#1779)", () => {
  const minted = mintedPrefixes();

  it("the scan actually finds the vocabulary (it would pass vacuously otherwise)", () => {
    // Representative modules plus every shared/declaration-based rule, so a regex that
    // silently stops matching fails here rather than turning the guard into a no-op.
    for (const known of [
      "take",
      "hh",
      "pvdone",
      "food",
      "offer",
      "tunet",
      "foodtime",
      "dosetimeat",
      "redose",
      // Both offer prefixes, so harvest rule (7) cannot quietly stop matching and
      // turn the shared-builder families into a blind spot.
      "usual",
      "stacktake",
      "medstop",
      // The mint site outside lib/notifications (#4544) — if EXTRA_MINT_SOURCES is ever
      // dropped, this fails here rather than silently re-opening the hole.
      "dgtuse",
    ]) {
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

  // ── HOST-INHERITED TOKENS (#2460) ─────────────────────────────────────────
  //
  // `usual:` decorates two message families and must elect NEITHER. The properties
  // below are the ones a mis-registration would break, and each is falsified by a
  // different one-line mutant: registering it `intake-dose` breaks the food case,
  // registering it `food` breaks the dose case, and dropping the HOST_INHERITED skip
  // in `owningFamily` breaks BOTH the moment the token sorts first — which it always
  // does, because the bundle sits above the rows it upgrades.
  describe("a host-inherited token never elects the keyboard's family", () => {
    const DOSE = [
      "all:7:Morning:2026-08-19",
      "take:7:41:9:2026-08-19",
      "skip:7:41:9:2026-08-19",
    ];
    const FOOD = ["food:7:Morning:2026-08-19:berries", "foodmore:7:Morning"];
    const USUAL = "usual:7:1201";

    // Every ORDER of the same buttons, so the answer cannot depend on where the
    // host-inherited token happens to sort. A keyboard is a list, and the send plan
    // puts `usual:` first.
    function permutations<T>(items: readonly T[]): T[][] {
      if (items.length <= 1) return [[...items]];
      return items.flatMap((item, i) =>
        permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((r) => [
          item,
          ...r,
        ])
      );
    }

    it("dose tokens + usual resolve to intake-dose, in every button order", () => {
      const orders = permutations([...DOSE, USUAL]);
      expect(orders.length).toBe(24);
      for (const order of orders) {
        expect(owningFamily(order, tokenPrefix), order.join(" | ")).toBe(
          "intake-dose"
        );
      }
    });

    it("food tokens + usual resolve to food, in every button order", () => {
      const orders = permutations([...FOOD, USUAL]);
      expect(orders.length).toBe(6);
      for (const order of orders) {
        expect(owningFamily(order, tokenPrefix), order.join(" | ")).toBe(
          "food"
        );
      }
    });

    it("the same keyboard resolves differently ONLY because of its host's tokens", () => {
      // The whole point, stated as one comparison: one token, two hosts, two answers.
      expect(owningFamily([USUAL, ...DOSE], tokenPrefix)).toBe("intake-dose");
      expect(owningFamily([USUAL, ...FOOD], tokenPrefix)).toBe("food");
    });

    it("a keyboard of only host-inherited tokens is INVALID, not merely unowned", () => {
      expect(owningFamily([USUAL], tokenPrefix)).toBeNull();
      expect(hasHostInheritedToken([USUAL], tokenPrefix)).toBe(true);
      // Invalid: nothing would own it, so nothing would ever reconcile it.
      expect(keyboardFamilyValid([USUAL], tokenPrefix)).toBe(false);
    });

    it("a host-inherited token is legal on a keyboard that has a family to inherit", () => {
      expect(keyboardFamilyValid([USUAL, ...DOSE], tokenPrefix)).toBe(true);
      expect(keyboardFamilyValid([USUAL, ...FOOD], tokenPrefix)).toBe(true);
    });

    it("validity says nothing about keyboards that carry no host-inherited token", () => {
      // A keyboard with no family at all (a fully collapsed digest) is unowned but
      // legal — the guard is about the host-inherited token specifically, and an
      // implementation that answered `owningFamily != null` would fail here.
      expect(keyboardFamilyValid(["tune:7"], tokenPrefix)).toBe(true);
      expect(owningFamily(["tune:7"], tokenPrefix)).toBeNull();
      expect(hasHostInheritedToken(DOSE, tokenPrefix)).toBe(false);
    });

    it("`usual` is declared HOST_INHERITED in the registry, not as a family", () => {
      const entry = reconcileEntryFor("usual");
      expect(entry?.family).toBe(HOST_INHERITED);
      // …and HOST_INHERITED is not a ReconcileFamily: nothing may register a
      // reconciler for it.
      expect(Object.keys(RECONCILE_DATE_GUARD)).not.toContain(HOST_INHERITED);
    });
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

// THE CORRECTION CHIPS' CLOCK (#2019/#2020/#2875).
//
// A registry entry answers "who owns this token", and the guard above makes sure every
// minted prefix has an owner. It cannot see the OTHER half: whether that owner's `dead`
// predicate actually ages the token out. A correction chip claims "these entries are
// still correctable here", which stops being true an hour after the burst — and the
// family is the only thing that says so.
//
// The practice domain shipped with the registry entries and no `dead` call, and the
// registry guard was green throughout. Two sweeps after the burst edited nothing, the
// chips stood until the 3-day pointer prune and then answered "Couldn't find those
// entries any more", and a nudge whose remaining claims were all chips never closed.
// So the pairing is asserted directly, as source text — the same posture as the
// vocabulary scan above, in the same tier, for the same reason.
//
// ── WHAT THIS GUARD COVERS, AND WHAT IT DOES NOT ─────────────────────────────
//
// Stated exactly, because an over-stated guard is worse than a narrow one — it is what
// stops the next person looking for the case it misses. Both bounds were established by
// running the mutants, not by reading.
//
// IT COVERS: that the family OWNING a domain's prefixes calls `deadCorrectionTokens` on
// that domain, inside its own `dead`. Scoping the scan to that family's `dead` body is
// what closes the hole a file-wide scan leaves — a fourth domain whose only call sat in
// a helper no family reached passed a global scan, because nothing tied the call to the
// family that owns the prefixes.
//
// IT ADMITS EVERY SPELLING OF THE SAME CODE, and that bound is as load-bearing as the
// other two. A guard that fails on a behaviour-preserving refactor is not conservative;
// it teaches the next person to edit the GUARD rather than the code, which is how a
// scan quietly stops meaning anything. Three refactors turned it red and now do not:
// writing a family's `dead` as an arrow property rather than a method (the dangerous
// one — the scan saw NO family that way and only `food` was ever anchored), aliasing
// the domain constant, and the natural fourth-domain move of one shared helper taking
// `prefixes` as a parameter. A domain is therefore recognised by its declared name, by
// any alias of it, or by its own prefix LITERALS — and the fixtures below pin each of
// those, against synthetic sources, so the scan's reach is tested rather than asserted.
//
// The alias resolution is TEXTUAL and one hop — a rename at the import, or a
// `const X = DOMAIN` in this file. A domain re-exported under a third name from a third
// module would not be recognised, and the answer there is a false POSITIVE (a domain
// reported as unswept when it is swept), which is the direction to fail in: it is read
// and argued with, where a false negative is silence.
//
// IT DOES NOT COVER what `dead` does with the result. Reverting only the early return on
// the empty-`wanted` path — half of the original defect, exactly as it shipped — leaves
// this file green: the call is still there, its result is simply dropped. Source text is
// the wrong instrument for that, and it is already pinned where behaviour is observable:
// `lib/__db_tests__/practice-time-correction.test.ts`'s "closes a nudge whose only
// remaining claims are lapsed chips" fails on that mutant. The pair is what covers the
// defect; neither half claims to do it alone.
describe("every correction domain reaches the sweep's clock (#2875)", () => {
  const CORRECTION_ROWS = path.join(NOTIFY_DIR, "correction-rows.ts");
  const RECONCILE = path.join(NOTIFY_DIR, "reconcile.ts");

  const reconcileSrc = () => stripComments(fs.readFileSync(RECONCILE, "utf8"));
  const domainsSrc = () =>
    stripComments(fs.readFileSync(CORRECTION_ROWS, "utf8"));

  // The source between the brace at `open` and its match. The scan needs BODIES, not
  // lines: what makes a call count is which body it sits in.
  function block(src: string, open: number): string {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
    }
    return "";
  }

  // The body of a function whose parameter list opens at `paren`. The parameters are
  // skipped by matching them rather than by looking for the next `{`: an inline object
  // TYPE in a signature (`p: { chatId: string }`) opens a brace that is not the body,
  // and reading that as the body is how a scan silently stops seeing anything.
  function bodyAfterParams(src: string, paren: number): string {
    let depth = 0;
    for (let i = paren; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0)
        return block(src, src.indexOf("{", i));
    }
    return "";
  }

  // The declared domains: `export const X: CorrectionPrefixes = { chip, at, … }`, with
  // the prefixes each one actually mints. The source is a PARAMETER so the cases below
  // can drive the scan with a fixture and prove what it can and cannot see.
  function declaredDomains(
    src = domainsSrc()
  ): { name: string; prefixes: string[] }[] {
    const out: { name: string; prefixes: string[] }[] = [];
    for (const m of src.matchAll(
      /export\s+const\s+([A-Z0-9_]+)\s*:\s*CorrectionPrefixes\s*=\s*/g
    )) {
      const body = block(src, src.indexOf("{", m.index + m[0].length));
      out.push({
        name: m[1],
        prefixes: [
          ...body.matchAll(/\b(?:chip|at):\s*"([a-z][a-z0-9]*)"/g),
        ].map((p) => p[1]),
      });
    }
    return out;
  }

  // Which `const <ident>: FamilyReconciler` implements each registry family key, read
  // off the FAMILIES record so a rename cannot silently unhook the scan.
  function familyImpls(src = reconcileSrc()): Map<string, string> {
    const at = src.indexOf("const FAMILIES");
    const body = block(src, src.indexOf("{", at));
    const out = new Map<string, string>();
    for (const m of body.matchAll(
      /(?:"([a-z-]+)"\s*:\s*(\w+)|^\s*(\w+)\s*,)/gm
    ))
      if (m[1]) out.set(m[1], m[2]);
      else if (m[3]) out.set(m[3], m[3]);
    return out;
  }

  // The module's own top-level functions, by name.
  function declaredFunctions(src: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g))
      out.set(m[1], bodyAfterParams(src, m.index + m[0].length - 1));
    for (const m of src.matchAll(
      /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=\s*(?:async\s*)?\([^)]*\)\s*(?::[^=\n]*)?=>\s*\{/g
    ))
      out.set(m[1], block(src, m.index + m[0].length - 1));
    return out;
  }

  // The source one family's `dead` can reach INSIDE reconcile.ts: its own body, plus the
  // bodies of every local function it names, transitively — #2817's rule, because the
  // same escape applies. Anything outside this scope is unreachable from the sweep, and
  // a `deadCorrectionTokens` call sitting there ages nothing out however plainly it
  // reads. Reaching THROUGH the scope is what makes an ordinary tidying refactor legal
  // while a helper nobody calls stays caught.
  // The family's `dead`, in whatever shape it is WRITTEN. A method, an arrow or function
  // property, or a reference to a named function elsewhere in the module are the same
  // predicate — and a scan that recognised only `dead(` saw none of a module whose
  // families are written the other way, which is a silent pass rather than a failure.
  function deadBody(family: string, fns: Map<string, string>): string | null {
    const m =
      /\bdead\s*(?::\s*(?:async\s+)?)?(?:\(|function\s*\(|([A-Za-z_$][\w$]*)\s*[,}])/.exec(
        family
      );
    if (!m) return null;
    // `dead: someNamedPredicate,` — the body is that function's.
    if (m[1]) return fns.get(m[1]) ?? "";
    return bodyAfterParams(family, family.indexOf("(", m.index));
  }

  // Every identifier that NAMES a domain where the sweep is written: its declared name,
  // an `import { NAME as ALIAS }` rename, and a local `const ALIAS = NAME`. Aliasing a
  // constant changes nothing about what the code does, so it may not change the answer.
  function domainNames(name: string, src: string): string[] {
    const out = [name];
    for (const m of src.matchAll(
      new RegExp(`\\b${name}\\s+as\\s+([A-Za-z_$][\\w$]*)`, "g")
    ))
      out.push(m[1]);
    for (const m of src.matchAll(
      new RegExp(
        `\\bconst\\s+([A-Za-z_$][\\w$]*)\\s*(?::[^=\\n]*)?=\\s*${name}\\s*[;\\n]`,
        "g"
      )
    ))
      out.push(m[1]);
    return out;
  }

  function deadScope(impl: string, src = reconcileSrc()): string {
    const at = src.search(
      new RegExp(`const\\s+${impl}\\s*:\\s*FamilyReconciler\\s*=\\s*\\{`)
    );
    if (at < 0) return "";
    const family = block(src, src.indexOf("{", at));
    const fns = declaredFunctions(src);
    const entry = deadBody(family, fns);
    if (entry == null) return "";
    const seen = new Set<string>();
    const queue = [entry];
    let scope = "";
    while (queue.length > 0) {
      const body = queue.pop() as string;
      scope += `\n${body}`;
      for (const [name, other] of fns)
        if (!seen.has(name) && new RegExp(`\\b${name}\\b`).test(body)) {
          seen.add(name);
          queue.push(other);
        }
    }
    return scope;
  }

  it("the scan finds both sides (it would pass vacuously otherwise)", () => {
    // Anchored on the ORIGINAL domain rather than on a count: a count assertion would
    // fail again for the very defect the next case reports, which reads as two bugs.
    const food = declaredDomains().find((d) => d.name === "FOOD_TIME_PREFIXES");
    expect(food?.prefixes).toEqual(["foodtime", "foodtimeat"]);
    expect(familyImpls().get("food")).toBe("food");
    expect(deadScope("food")).toContain("deadCorrectionTokens(");
  });

  // Does this family's `dead` reach the clock FOR THIS DOMAIN? Two questions, and they
  // are asked separately on purpose: that the scope calls `deadCorrectionTokens` at all,
  // and that the domain is what it is called ABOUT. The second is answered by any of the
  // domain's names — declared, aliased — or by its own prefix literals, because the one
  // refactor a fourth domain invites is a shared helper taking `prefixes` as a parameter,
  // and there the constant reaches the call through an argument rather than beside it.
  function reachesClock(
    domain: { name: string; prefixes: string[] },
    scope: string,
    src: string
  ): boolean {
    if (!/deadCorrectionTokens\s*\(/.test(scope)) return false;
    const names = domainNames(domain.name, src).map((n) => `\\b${n}\\b`);
    const literals = domain.prefixes.map((p) => `"${p}"`);
    return new RegExp([...names, ...literals].join("|")).test(scope);
  }

  it("every declared domain's chips die on the hour-long clock, in ITS OWN family", () => {
    const src = reconcileSrc();
    const impls = familyImpls(src);
    const unswept: string[] = [];
    for (const domain of declaredDomains()) {
      // The family is resolved from the PREFIXES, not from a name match: a domain is
      // swept by whichever family owns the tokens it mints, and that is the pairing a
      // file-wide scan cannot see.
      const family = owningFamily(domain.prefixes, (t) => t);
      const impl = family ? impls.get(family) : null;
      const scope = impl ? deadScope(impl, src) : "";
      if (!reachesClock(domain, scope, src))
        unswept.push(`${domain.name} (family: ${family ?? "none"})`);
    }
    expect(
      unswept,
      `these correction domains have no clock: ${unswept.join(", ")}. A family ` +
        `whose \`dead\` never calls deadCorrectionTokens on its OWN domain leaves ` +
        `its chips on the keyboard until the pointer is pruned days later, where ` +
        `they answer "Couldn't find those entries any more" — and a message whose ` +
        `only remaining claims are chips is never closed at all.`
    ).toEqual([]);
  });

  // ---- what the scan can SEE, driven by fixtures rather than by the real files ----
  //
  // Each of these is a behaviour-preserving way of writing the same sweep. The scan has
  // to give the same answer for all of them, because a guard that goes red on a tidying
  // refactor gets edited instead of obeyed — and the edit that silences it is the same
  // edit that blinds it.

  // A reconcile.ts in miniature: one domain, one family, one registry hook.
  function fixture(dead: string, extra = ""): string {
    return `
import { WOTIME } from "./correction-rows";
${extra}
const workout: FamilyReconciler = {
  ${dead}
};
const FAMILIES = { workout };
`;
  }
  const WOTIME = { name: "WOTIME", prefixes: ["wotime", "wotimeat"] };

  it("sees a `dead` written as an arrow property, not only as a method", () => {
    // THE DANGEROUS ONE. `dead(` matched a method and nothing else, so a module whose
    // families are written as arrow properties had NO family the scan could enter — it
    // stayed green while every domain went unswept.
    const method = fixture(
      `dead(profileId, tokens, p) { return deadCorrectionTokens(tokens, WOTIME, p); },`
    );
    const arrow = fixture(
      `dead: (profileId, tokens, p) => { return deadCorrectionTokens(tokens, WOTIME, p); },`
    );
    for (const src of [method, arrow]) {
      expect(deadScope("workout", src)).toContain("deadCorrectionTokens(");
      expect(reachesClock(WOTIME, deadScope("workout", src), src)).toBe(true);
    }
  });

  it("follows a `dead` that is a reference to a named predicate", () => {
    const src = fixture(
      `dead: workoutDead,`,
      `
function workoutDead(profileId, tokens, p) {
  return deadCorrectionTokens(tokens, WOTIME, p);
}
`
    );
    expect(reachesClock(WOTIME, deadScope("workout", src), src)).toBe(true);
  });

  it("counts an ALIASED constant as the domain it is", () => {
    const src = fixture(
      `dead(profileId, tokens, p) { return deadCorrectionTokens(tokens, WORKOUT_CHIPS, p); },`,
      `const WORKOUT_CHIPS = WOTIME;`
    );
    expect(reachesClock(WOTIME, deadScope("workout", src), src)).toBe(true);
  });

  it("counts a shared helper that takes the prefixes as a PARAMETER", () => {
    // The natural refactor when a fourth domain arrives: one helper, the domain passed
    // in. The constant then reaches the call through an argument, so requiring it beside
    // `deadCorrectionTokens(` reports a defect that is not there.
    const src = fixture(
      `dead(profileId, tokens, p) { return chipClock(tokens, WOTIME, p); },`,
      `
function chipClock(tokens, prefixes, p) {
  return deadCorrectionTokens(tokens, prefixes, liveAnchors(p));
}
`
    );
    expect(reachesClock(WOTIME, deadScope("workout", src), src)).toBe(true);
  });

  it("still fails a call the family's `dead` cannot reach", () => {
    // The hole the file-wide scan left, re-pinned against the looser matcher: a helper
    // nobody calls sweeps nothing, however plainly it reads.
    const src = fixture(
      `dead(profileId, tokens) { return new Set(); },`,
      `
function unusedClock(tokens, p) {
  return deadCorrectionTokens(tokens, WOTIME, p);
}
`
    );
    expect(reachesClock(WOTIME, deadScope("workout", src), src)).toBe(false);
  });

  it("still fails a family that sweeps somebody ELSE's domain", () => {
    const src = fixture(
      `dead(profileId, tokens, p) { return deadCorrectionTokens(tokens, FOOD_TIME_PREFIXES, p); },`
    );
    expect(reachesClock(WOTIME, deadScope("workout", src), src)).toBe(false);
  });

  it("reads a fixture's domain declarations the same way it reads the real file", () => {
    // The fixtures above hand the domain in by hand; this is what stops that being a
    // fiction — `declaredDomains` finds the same shape in a synthetic source.
    expect(
      declaredDomains(
        `export const WOTIME: CorrectionPrefixes = { chip: "wotime", at: "wotimeat", dayKeyed: false };`
      )
    ).toEqual([{ name: "WOTIME", prefixes: ["wotime", "wotimeat"] }]);
  });

  it("every declared domain's prefixes are owned by a family, not inert", () => {
    // A chip declared INERT would be swept-proof in the other direction: `dead` would
    // never be consulted for it. The pair has to be a real claim on a real family.
    const prefixes = declaredDomains().flatMap((d) => d.prefixes);
    expect(prefixes.length).toBeGreaterThanOrEqual(6);
    for (const p of prefixes) {
      const entry = reconcileEntryFor(p);
      expect(
        entry,
        `no registry entry for correction prefix "${p}"`
      ).toBeTruthy();
      expect(
        entry && "family" in entry ? entry.family : null,
        `correction prefix "${p}" must be owned by a family, never inert`
      ).toBeTruthy();
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
    expect(inertTokens(["mystery:1:2"], tokenPrefix, false).size).toBe(0);
    expect(owningFamily(["mystery:1:2"], tokenPrefix)).toBeNull();
  });

  it("claim views expire with their claims; standalone controls do not", () => {
    const tokens = [
      `foodmore:7:Morning:${DATE}`,
      `tune:7:${DATE}`,
      `take:7:1:1:${DATE}`,
    ];
    expect([...inertTokens(tokens, tokenPrefix, false)]).toEqual(
      tokens.slice(0, 2)
    );
    expect([...inertTokens(tokens, tokenPrefix, true)]).toEqual([
      `tune:7:${DATE}`,
    ]);
  });
});

// THE THIRD COMPLETENESS GUARD (issue #2018). The prefix table asks "what happens when
// this BUTTON is still in the chat tomorrow?"; KIND_REISSUE asks "does sending this again
// replace the last one?". This one asks, per FAMILY, "HOW LATE may this message still be
// acted on?" — the question #1784 answered once, globally, with the day boundary, which
// is `tapDateGuard`'s rule applied to families whose handlers never agreed to it.
//
// The pin that matters is the AGREEMENT property: for every family that has a date guard,
// the sweep's verdict must equal the guard the family declares, over the whole range of
// (message date, today) pairs. That is what stops a fourth opinion about how late a tap
// may land from appearing later.
describe("the date-guard completeness guard (#2018)", () => {
  const D = "2020-03-04";
  const FAMILIES = Object.keys(RECONCILE_DATE_GUARD) as ReconcileFamily[];
  // −4 … +4 days around the message's own date: wide enough to cross both boundaries.
  const OFFSETS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];

  it("every family declares which guard decides how late its message may be tapped", () => {
    // The Record type makes a MISSING family a compile error; this catches the other
    // half — an entry that answers with a placeholder instead of a reason.
    for (const family of FAMILIES) {
      const entry = RECONCILE_DATE_GUARD[family];
      expect(["exact-day", "dose-window", "none"]).toContain(entry.guard);
      expect(entry.why.length, `${family} needs a real reason`).toBeGreaterThan(
        40
      );
    }
  });

  it("the declaration covers exactly the families that exist — no stale entry", () => {
    const owning = new Set(
      RECONCILE_PREFIXES.map((e) => e.family).filter(
        // HOST_INHERITED is not a family and has no reconciler of its own (#2460):
        // the token takes its host message's family, so there is nothing here to
        // declare a date guard for.
        (f) => f != null && f !== HOST_INHERITED
      )
    );
    expect([...FAMILIES].sort()).toEqual([...owning].sort());
  });

  it("an EXACT-DAY family's verdict is tapDateGuard's, on every date pair", () => {
    for (const family of FAMILIES) {
      if (RECONCILE_DATE_GUARD[family].guard !== "exact-day") continue;
      for (const offset of OFFSETS) {
        const todayStr = shiftDateStr(D, offset);
        const handlerRefuses = tapDateGuard(D, todayStr).kind === "stale-date";
        expect(
          messageExpiry(family, D, todayStr) != null,
          `${family} at D${offset >= 0 ? "+" : ""}${offset}`
        ).toBe(handlerRefuses);
      }
    }
  });

  it("a DOSE-WINDOW family's verdict is isDoseDateAccepted's, on every date pair", () => {
    for (const family of FAMILIES) {
      if (RECONCILE_DATE_GUARD[family].guard !== "dose-window") continue;
      for (const offset of OFFSETS) {
        const todayStr = shiftDateStr(D, offset);
        const handlerRefuses = !isDoseDateAccepted(todayStr, D);
        expect(
          messageExpiry(family, D, todayStr) != null,
          `${family} at D${offset >= 0 ? "+" : ""}${offset}`
        ).toBe(handlerRefuses);
      }
    }
  });

  it("a family with NO date axis never expires — only its `dead` predicate ends it", () => {
    for (const family of FAMILIES) {
      if (RECONCILE_DATE_GUARD[family].guard !== "none") continue;
      for (const offset of OFFSETS) {
        expect(messageExpiry(family, D, shiftDateStr(D, offset))).toBeNull();
      }
    }
  });

  it("the two date closes stay distinguishable — a run-out window is not 'yesterday'", () => {
    // A rollover close says "this is yesterday's message"; a dose past its window needs
    // to be told the confirm can no longer land here. Same branch, different sentence.
    //
    // `mood` rather than `food` since #4118: the food nudge moved onto the dose window
    // when its handler did, so it is no longer an example of a rollover close at all.
    // The exemplar has to be a family that is still `exact-day`, or this assertion
    // would pin an entry it does not describe — and the moment none is left, the
    // rollover branch has no producer and someone should be told rather than have this
    // test quietly re-point again.
    expect(messageExpiry("mood", D, shiftDateStr(D, 1))).toBe("rollover");
    expect(messageExpiry("food", D, shiftDateStr(D, 1))).toBeNull();
    expect(
      messageExpiry(
        "intake-dose",
        D,
        shiftDateStr(D, DOSE_LOG_DATE_WINDOW_DAYS + 1)
      )
    ).toBe("expired");
  });

  it("an unreasoned or claim-less keyboard never expires — the same fail-safe `dead` takes", () => {
    expect(messageExpiry(null, D, shiftDateStr(D, 9))).toBeNull();
  });
});

// ── The PROSE-CLAIM completeness guard (issue #1913 item 4) ──────────────────
//
// #1779 asked, per BUTTON, "what happens when this is still in the chat tomorrow?" and
// #1898 asked, per KIND, "does sending this again replace the last one?". Both are
// keyboard-shaped, and the digest slipped between them: its every token is (correctly)
// inert, so `owningFamily` returned null and the sweep concluded there was nothing to
// reconcile — while its CLAIMS sat in its prose, stating a missed dose the user had
// already logged. This guard asks the third question of every kind, so the next
// report-shaped message has to answer it rather than inherit the same silence.
describe("the prose-claim completeness guard (#1913)", () => {
  it("every notification kind declares whether its PROSE reconciles", () => {
    const declared = new Set(KIND_PROSE.map((e) => e.kind as string));
    const undeclared = ALL_NOTIFICATION_KINDS.filter((k) => !declared.has(k));
    expect(
      undeclared,
      `kinds with no prose declaration: ${undeclared.join(", ")} — add a ` +
        `KIND_PROSE entry saying whether this message's SENTENCES make a claim an ` +
        `in-app write can resolve, and why`
    ).toEqual([]);
  });

  it("no STALE declaration — every declared kind is still a real kind", () => {
    const known = new Set<string>(ALL_NOTIFICATION_KINDS);
    const stale = KIND_PROSE.filter((e) => !known.has(e.kind)).map(
      (e) => e.kind
    );
    expect(stale, `retired kinds still declared: ${stale.join(", ")}`).toEqual(
      []
    );
  });

  it("both answers carry a real reason — including every 'no'", () => {
    for (const e of KIND_PROSE) {
      expect(e.why.length, `${e.kind} needs a real reason`).toBeGreaterThan(40);
    }
  });

  it("no duplicate kinds", () => {
    const seen = new Set<string>();
    for (const e of KIND_PROSE) {
      expect(seen.has(e.kind), `duplicate declaration for "${e.kind}"`).toBe(
        false
      );
      seen.add(e.kind);
    }
  });

  it("the digest reconciles; the catch-all and an unknown kind never do", () => {
    expect(proseReconcilerFor("digest")).toBe("digest");
    // A reconciler on "other" would re-render arbitrary unrelated messages through
    // somebody else's builder.
    expect(proseReconcilerFor("other")).toBeNull();
    expect(proseReconcilerFor(undefined)).toBeNull();
    expect(proseReconcilerFor("not-a-kind")).toBeNull();
  });

  it("the weekly recap has answered — the next report-shaped message must too", () => {
    // Named explicitly by the issue: a recap describes seven days that are already over,
    // so its claims are history the moment they are made.
    const recap = KIND_PROSE.find((e) => e.kind === "weekly-recap");
    expect(recap?.prose).toBeNull();
    expect(recap?.why).toContain("history");
  });
});
