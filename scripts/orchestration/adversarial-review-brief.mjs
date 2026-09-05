// Adversarial-review lane: verdict + refuter brief (plain Node, no deps).
//
// The best defect detector this repo has is post-merge: #2444 (a shipped
// migration whose FK-guard was silently dead) was caught by a scheduled review
// of already-landed commits, and by nothing else — not the authoring agent, not
// the pre-merge review, not CI. The pre-merge review verifies a diff against
// its own claims, by the same orchestrator that wrote the brief, from the same
// model family: a single non-adversarial lane. This script is the second lane
// for the diffs where a miss corrupts data or crosses an auth boundary — a
// SEPARATE agent, prompted to REFUTE the PR's claims rather than summarize
// them, before the merge instead of 24 hours after it.
//
// Usage:
//   node scripts/orchestration/adversarial-review-brief.mjs <pr-number> [--check]
//
// Default: prints the verdict (with its evidence) to stderr and, if a declared
// high-stakes path matched (or --force), the full refuter brief to stdout —
// paste it verbatim as the refuter agent's prompt.
// --check: verdict only, as an exit code.
//
// ── THE THREE ANSWERS, AND WHY "I DO NOT KNOW" IS NOT ONE OF THEM ────────────
//
//   0  MANDATORY     a declared high-stakes path matched; dispatch the falsifier.
//   3  CONSULT       no declared path matched, but the PR's own text is about a
//                    safety-relevant behaviour. The ORCHESTRATOR decides.
//   1  ordinary      neither a declared path nor the safety vocabulary matched.
//   2  cannot answer the tool could not read the PR at all (see `fail` below).
//
// 2 and 3 are BOTH refusals to answer, and they are refusals of DIFFERENT
// questions — the next editor has to keep them apart. 2 means the tool never got
// the facts: the curl failed, the body was not JSON, the PR number does not
// resolve. 3 means the tool has every fact it can have and the facts do not
// settle it, because whether a change decides something safety-relevant is a
// semantic question and no path rule answers it.
//
// Both exist for one reason, stated for errors alone until #3030 and now reaching
// the case it was always about: A GUARD MUST NOT FAIL INTO ITS PERMISSIVE ANSWER.
// `--check` exited 1 for BOTH "I checked, and this is ordinary" and "nobody has
// ever classified this", and 1 is the code a caller reads as "skip the lane". Five
// PRs (#2929, #2955, #3004, #3018, #3028) were reported as the first when they
// were the second, and all five were caught by an orchestrator overriding the tool
// by hand — never by the tool. Exit 1 is now an ANSWER, not a default.
//
// The high-stakes list is DECLARED HERE and nowhere else (the runbook points at
// this file). Membership rule: a path is high-stakes when a plausible bug in it
// corrupts stored data, crosses the login/profile authorization boundary, or
// silently disables a safety signal — not merely when it is important.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { helpGuard } from "./usage.mjs";
import { resolveReadToken } from "./host.mjs";
helpGuard(process.argv, import.meta.url);

export const EXIT = {
  mandatory: 0,
  ordinary: 1,
  cannotAnswer: 2,
  consult: 3,
};

export const HIGH_STAKES = [
  // Corrupts every database if wrong; runs unattended at boot.
  {
    glob: /^lib\/migrations\//,
    why: "migration runner/versions — a bug corrupts every database at boot",
  },
  { glob: /^lib\/db\.ts$/, why: "connection + boot work" },
  // The authorization boundary.
  {
    glob: /^lib\/auth\.ts$/,
    why: "sessions and access checks — the login/profile boundary",
  },
  { glob: /^lib\/password\.ts$/, why: "credential hashing" },
  { glob: /^middleware\.ts$/, why: "the Edge cookie gate" },
  // Redaction is a DISCLOSURE boundary, not log hygiene. #2935 gave
  // `redactSecrets` its first profile-facing consumer, so a shape it fails to
  // mask is a credential on a user's screen. Added after this registry answered
  // "not high-stakes" for #2955 — a rewrite of that very function — which is the
  // same miss as `lib/dri.ts` (#2932): the tier was read as "which subsystem"
  // when the question is "what does a bug here disclose or decide".
  {
    glob: /^lib\/(error-log-format|log)\.ts$/,
    why: "secret redaction — a shape it misses is a credential shown to a user, and over-redaction destroys an error they must act on",
  },
  {
    glob: /^lib\/public-paths\.ts$/,
    why: "the session-free route list — one entry too many is an open door",
  },
  // Last-line-of-defense data safety.
  {
    glob: /^lib\/backup/,
    why: "backup path — failures here are silent until the day they are everything",
  },
  {
    glob: /^lib\/restore\.ts$/,
    why: "restore path — overwrites the live database",
  },
  {
    glob: /^scripts\/(backup|restore)\.ts$/,
    why: "operator backup/restore CLIs",
  },
  // A DELETE THE USER DID NOT ASK FOR is the same tier as the backup path, and
  // for the reason the backup entry gives: it is silent until the day it is
  // everything. Nearly every other `DELETE FROM` in this tree is
  // `WHERE id = ? AND profile_id = ?` behind an explicit affordance — the user
  // asked, and a bug deletes the row they were looking at. This module is the
  // exception: it deletes a RANGE of ingested health readings as a side effect
  // of a settings change, unattended, and nothing in the UI says a reading is
  // about to go. #3524 is what that costs — four days of resting heart rate
  // destroyed on production across two travel switches, discovered only because
  // the owner went looking, and recoverable only from a host backup.
  //
  // SIXTH instance of the miss recorded five times below and above: --check
  // answered "ordinary" for PR #3539, which narrows this very sweep, because the
  // question was read as "which subsystem" (integrations) rather than "what does
  // a bug here destroy". The four earlier repairs added the file that had just
  // been missed; so does this one. THE TEST FOR A SIBLING: does this module
  // delete rows the user did not ask it to delete? If yes it belongs here,
  // whatever subsystem it lives in. A bulk delete BEHIND an explicit
  // user affordance (`data/manage-actions.ts`'s "delete all my X", the family
  // profile cascade) does not qualify on its own — the user is present and
  // confirming — though either would qualify on other grounds if its scoping
  // changed.
  {
    glob: /^lib\/integrations\/ingest-timezone-sweep\.ts$/,
    why: "unattended deletion of ingested health rows on a timezone change — a bug destroys readings the user recorded and no source will re-send",
  },
  // The safety-signal tier: dose reminders and escalations must never be
  // silently disabled (findings doctrine: their justification is not effectiveness).
  {
    glob: /^lib\/notifications\//,
    why: "send/suppression machinery — a bug here silences a safety signal",
  },
  {
    glob: /^lib\/nudge-cadence\.ts$/,
    why: "the send/freeze decision every safety planner rides",
  },
  // The safety signal is DECIDED before it is sent, and this list covered only
  // the sending half until PR #2929 walked through the gap (2026-08-15): a change
  // to the upper-limit arithmetic in `lib/dri.ts` — which by its author's own
  // account could make a firing warning go quiet — was reported "not high-stakes"
  // because no declared path matched, and the orchestrator had to override the
  // tool by hand. A warning that is never computed is as silent as one that is
  // never sent, so the modules that decide whether there is something to warn
  // about belong at the same tier as the ones that deliver it.
  {
    glob: /^lib\/dri\.ts$/,
    why: "DRI/upper-limit arithmetic — a bug here makes an over-limit stack stop warning",
  },
  {
    glob: /^lib\/(drug-interactions|food-drug-interactions|supplement-safety)\.ts$/,
    why: "interaction engines — a miss drops a contraindication the app already knew",
  },
  {
    glob: /^lib\/(contrast-safety|dental-safety|weather-med-safety)\.ts$/,
    why: "situational safety checks — each one is the only thing standing between a stored fact and a harmful action",
  },
  // Writes replayed later with captured state.
  {
    glob: /^lib\/offline\//,
    why: "offline queue/replay — writes applied later, out of their original context",
  },
  // The life-stage refusal is a SAFETY gate, not a preference (#2756), and the
  // registry beside it decides which cores carry it. This entry was added after
  // the same miss recorded above for `redactSecrets` and `lib/dri.ts` happened a
  // third time: #3004 rewrote the exemption CRITERION — from "can this leave an
  // active fast" to "can this leave fasting content" — and `--check` answered
  // "not high-stakes" because no declared path matched. A core wrongly exempted
  // here records eating-restriction data on a known-minor profile, which is the
  // harm the gate exists to prevent, so the question this registry asks — what
  // does a bug here disclose or decide — is answered by the gate itself.
  {
    glob: /^lib\/(adult-only-writes|life-stage)\.ts$/,
    why: "the life-stage safety gate and the registry of which write cores carry it — a core wrongly exempted records restricted content on a minor",
  },
  // The gate is only as good as the age it is handed, and the age resolver is a
  // DIFFERENT FILE from the gate. #3018 changed what every life-stage predicate
  // SEES — `getStoredAge` had conflated "this profile is an infant" with "we do
  // not know this profile's age" — and `--check` answered "not high-stakes"
  // because the diff touched no declared path: the gates themselves needed no
  // edit, which is exactly why the change was invisible to a subsystem-shaped
  // reading. Fourth instance of the miss recorded twice above; the question is
  // never "which subsystem" but "what does a bug here decide", and this file
  // decides whether a profile is a minor.
  {
    glob: /^lib\/settings\/profile-attrs\.ts$/,
    why: "the age resolver every life-stage gate reads — a wrong or absent age makes a minor pass an adult-only check",
  },
];

// ---- the DIFF tier: what the change actually DOES ---------------------------
//
// #4842. The two tiers above read a PATH and a PARAGRAPH, and both directions of
// that failed in one night:
//
//   * FALSE NEGATIVE. PR #4801 moved a write-authorization boundary — an action's
//     `requireWriteAccess()` became `gateItemProfile(formData)`, so a client-posted
//     `profile_id` now decides whose dose row is written — and came back `ordinary`,
//     because it described the change in mechanism ("threads the subject through the
//     panel") rather than in category. A falsifying pass run over the tool's head
//     REFUTED it. PR #4834 the same, one surface over.
//   * FALSE POSITIVE. PR #4881 came back CONSULT quoting
//     "| `phi-scan` | OK — no likely-real PHI in 5440 files |" — a gate reporting
//     that it found NOTHING, read as a claim that PHI was leaving a surface.
//
// One cause: an author can phrase either mistake into existence without meaning
// to, and the better the PR's writing is about mechanism the less its prose trips
// a keyword. So the EVIDENCE is now the hunks. A call to the write gate is on a
// changed line or it is not; a `profile_id` predicate is in the WHERE clause or it
// is not. Neither is a matter of phrasing.
//
// WHERE THIS VOCABULARY COMES FROM, since a guard's pattern must be how the REPO
// writes the construct and not how an issue describes it. Every symbol below was
// taken from the module that DEFINES it and then counted, not read off a list in
// an issue. Counts are at 2ec49466 (this change's merge base), over lib/, app/ and
// components/; the call-shaped ones with
// `git grep -c "\b<sym>\s*(" 2ec49466 -- lib/ app/ components/` and the two that
// are read as bare identifiers with `\b<sym>\b`:
//   lib/auth.ts             requireWriteAccess 402, requireProfileWriteAccess 146,
//                           requireAdmin 95, accessForProfile 35,
//                           requireLoginWriteAccess 17, accessibleProfiles 13,
//                           accessibleProfilesForLogin 21
//   app/(app)/gate-item.ts  gateItemProfile 157
//   lib/scope.ts            requireScope 38
//   lib/cross-profile.ts    profileIdsIn 46, authorizedProfileSubset 16
//   lib/multi-view.ts       readForProfiles 54, itemAffordanceVisible 21,
//                           subjectChipVisible 19
//   lib/appointment-sensitivity.ts  sharedSurfaceDetail 19
//   lib/notifications/managing-logins.ts  managingLoginIdsForProfile 40
//   the cross-profile render flag `crossProfile`, 49 across 11 files
//
// `requireSession` is DELIBERATELY ABSENT. It authenticates and decides no write
// authority (lib/auth.ts says so: the write guard is the authoritative boundary,
// and requireSession is what every read page calls), it has 189 call sites, and a
// new page adds one — so it names a fact about every diff rather than about this
// one.

/**
 * Signals read from a CHANGED LINE, either side of the diff. The question is not
 * "was this call added" but "did this diff move it at all": #4801 removed
 * `requireWriteAccess()` and added `gateItemProfile()` in one hunk, #4702 deleted a
 * gated cross-profile action outright, and a gate that moves is the boundary
 * moving whichever sign the line carries.
 */
export const CHANGED_CALL_SIGNALS = [
  {
    signal: "authorization gate",
    verdict: "MANDATORY",
    rx: /\b(?:requireWriteAccess|requireProfileWriteAccess|requireLoginWriteAccess|requireAdmin|gateItemProfile|accessForProfile|accessibleProfiles(?:ForLogin)?|requireScope|authorizedProfileSubset|profileIdsIn)\s*\(/,
    why: "a call that decides who may write or reach a profile's rows changed position — the login/profile authorization boundary moved",
  },
  {
    signal: "cross-profile visibility",
    verdict: "CONSULT",
    rx: /\b(?:sharedSurface[A-Za-z]*|itemAffordanceVisible|subjectChipVisible|readForProfiles|managingLoginIdsForProfile|crossProfile)\b/,
    why: "what a shared surface shows about ANOTHER profile changed — an orchestrator reads the hunk, because widening and narrowing look identical from outside",
  },
];

/**
 * Signals read as a NET COUNT over the whole diff, because the hazard is LOSS and
 * a construct MOVED between two files in one PR is not a loss. Whole-diff rather
 * than per-file for exactly that reason: #4706 moved a profile-scoped DELETE out
 * of one write core, and per-file it read as a removal.
 *
 * ONE DIRECTION, and the asymmetry is measured rather than assumed. Over the 96
 * PRs merged to 2026-09-03 (#4652–#4881) a net writeTx REMOVAL occurs 0 times and
 * a net ADDITION twice (#4746 wraps a new supersede write, #4831 moves one
 * writeTx from `notifications/index.ts` into `delivery-marker.ts`) — neither is
 * the hazard, and a write path that GAINS a transaction fails loudly in the DB
 * tier while one that loses it corrupts silently.
 */
export const NET_REMOVAL_SIGNALS = [
  {
    signal: "profile scoping",
    rx: /\bprofile_id\s*(?:=|!=|<>)|\bprofile_id\s+IN\b/gi,
    why: "a query lost a profile_id predicate — the filter that keeps one profile's rows out of another's read or write",
  },
  {
    signal: "write transaction",
    rx: /\bwriteTx\s*\(|\.immediate\(\)/g,
    why: "a write path lost its IMMEDIATE transaction (#468) — a read-then-write that no longer commits atomically",
  },
];

// A comment is not a call. #4702's household action deleted an eleven-line comment
// NAMING requireProfileWriteAccess as well as the call itself; without this the
// quoted evidence is the sentence about the gate rather than the gate.
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * Every changed line of a shipped, non-test file, with the hunk header it sits
 * under — so a verdict can name the file AND the hunk that earned it rather than
 * a keyword.
 *
 * @param {string | undefined} patch a unified diff
 * @returns {{ hunk: string, sign: 1 | -1, text: string }[]}
 */
function changedLines(patch) {
  const out = [];
  let hunk = "";
  for (const line of (patch ?? "").split("\n")) {
    if (line.startsWith("@@")) {
      hunk = line.slice(0, line.indexOf("@@", 2) + 2);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    const text = line.slice(1);
    if (COMMENT_LINE.test(text)) continue;
    out.push({ hunk, sign: line.startsWith("+") ? 1 : -1, text });
  }
  return out;
}

/**
 * What the diff DOES, as evidence: one entry per signal per file, each quoting the
 * changed line and naming its hunk.
 *
 * @param {string[]} files
 * @param {Record<string, string>} [patches] filename -> unified diff
 * @returns {{ file: string, hunk: string, signal: string, verdict: string,
 *   why: string, line: string }[]}
 */
export function diffSignals(files, patches) {
  const hits = [];
  const shipped = files.filter(
    (f) => SHIPPED_CODE.test(f) && !TEST_FILE.test(f)
  );
  const net = new Map(NET_REMOVAL_SIGNALS.map((s) => [s.signal, 0]));
  const lastRemoval = new Map();
  for (const file of shipped) {
    const seen = new Set();
    for (const { hunk, sign, text } of changedLines(patches?.[file])) {
      for (const rule of CHANGED_CALL_SIGNALS) {
        if (seen.has(rule.signal) || !rule.rx.test(text)) continue;
        seen.add(rule.signal);
        hits.push({
          file,
          hunk,
          signal: rule.signal,
          verdict: rule.verdict,
          why: rule.why,
          line: `${sign > 0 ? "+" : "-"}${text.trim()}`,
        });
      }
      for (const rule of NET_REMOVAL_SIGNALS) {
        const n = (text.match(rule.rx) ?? []).length;
        if (!n) continue;
        net.set(rule.signal, net.get(rule.signal) + sign * n);
        if (sign < 0) lastRemoval.set(rule.signal, { file, hunk, text });
      }
    }
  }
  for (const rule of NET_REMOVAL_SIGNALS) {
    if (net.get(rule.signal) >= 0) continue;
    const at = lastRemoval.get(rule.signal);
    hits.push({
      file: at.file,
      hunk: at.hunk,
      signal: rule.signal,
      verdict: "MANDATORY",
      why: rule.why,
      line: `-${at.text.trim()}`,
    });
  }
  return hits;
}

// ---- the CONSULT tier: what the PR says about itself ------------------------
//
// Four of the five misses above were repaired by adding a glob for the file that
// had just been missed, and the fifth arrived one layer further out anyway. What
// the five actually share is not a directory: each PRODUCES OR GATES A
// SAFETY-RELEVANT VALUE — a redaction boundary, an upper-limit computation behind
// a warning, a gate's exemption criterion, the age a gate reads, the age one layer
// above that. That is semantic, and no path rule finds it. But every one of them
// SAID SO IN WORDS, in its own title, body or linked issue.
//
// So this tier reads the claim, not the diff. It never says MANDATORY — a word is
// not evidence of a defect — it says CONSULT, and an orchestrator decides.
//
// ── WHEN THIS VOCABULARY MAY GAIN A TERM ────────────────────────────────────
//
// It is NOT a list of the words the last miss happened to use, and a term is not
// admitted because it appears in a PR that turned out to matter. The test a
// future editor applies, in order:
//
//   1. In THIS repo's writing, does the term name a safety-relevant VALUE or
//      DECISION — something disclosed, gated, computed-then-warned-about, or
//      resolved about a person? If it names a subsystem, a file or a feature, it
//      belongs in HIGH_STAKES as a path or nowhere.
//   2. Does it have an ordinary sense that OUTNUMBERS the safety sense here? Run
//      it over a real recent window of merged PRs and count. Bare `flag`, `dose`
//      and `minor` all failed this on the 100-PR window of 2026-08-16 — `flagged
//      this family`, `the dose chip`, `the batched minors` — so each was admitted
//      only in the phrase that carries the safety sense (`red flag`, `missed
//      dose`, `a minor`). A term that cannot be narrowed that way is rejected.
//   3. Does adding it change the measured false-CONSULT rate? State the new rate
//      in the block below. A term that fires on nothing is not free — it is an
//      unmeasured claim in a file whose whole subject is unmeasured claims.
//
// Worked examples of a term admitted under (2) rather than deleted: `warning`
// survives whole (one ordinary hit in 153 PRs), `dose` does not (four).
//
// ── THE MEASURED COST ───────────────────────────────────────────────────────
//
// Over the 100 merged PRs to 2026-08-16 (#2842–#3036), 73 were path-ordinary and
// 5 of those come back CONSULT: 6.8%. Over the 94 merged PRs before them
// (#2634–#2841), HELD OUT while the vocabulary was narrowed, 80 were path-ordinary
// and 4 come back CONSULT: 5.0%. Combined, 9 in 153 path-ordinary PRs — 5.9% —
// counted as if every CONSULT were spurious. Six of the nine in fact name a real
// safety boundary in the diff's own subject (#2722's missed-dose escalations,
// #2720's alcohol logging for a minor, #2697's `isMinor` gate, #2647's `adultOnly`
// pairs, #2916's contraindications, #2910's age-gated route), so the rate of
// CONSULTs an orchestrator would resent is 3 in 153, 2.0%. The starting vocabulary
// — the terms the ruling listed, unnarrowed — measured 52% on the first window.

// The movement PHI's `why` names, in the words this repo writes it with. Kept
// beside the term it narrows rather than inlined twice, which is the only reason
// it is a string: `minor` spells its co-location out both ways in one literal and
// is half the length.
const LEAVES_A_SURFACE =
  "(?:export\\w*|expos\\w*|leak\\w*|disclos\\w*|shares?|shared|sharing|render\\w*|" +
  "logs?|logged|logging|sends?|sent|sending|emails?|emailed|prints?|printed|" +
  "copy|copies|copied|surfaces?|surfaced|surfacing|redact\\w*|mask\\w*|" +
  "transmit\\w*|upload\\w*|download\\w*|screenshots?)";

// `(?!-)` still holds `phi-scan` out even when a disclosure word is beside it.
const PHI_DISCLOSURE = new RegExp(
  `\\bPHI\\b(?!-)(?=[^.!?\\n]{0,90}\\b${LEAVES_A_SURFACE}\\b)|` +
    `\\b${LEAVES_A_SURFACE}\\b[^.!?\\n]{0,90}\\bPHI\\b(?!-)`,
  "i"
);

export const SAFETY_VOCABULARY = [
  {
    term: "minor (the person)",
    // `minor` is the only term here whose ordinary sense is a DIFFERENT PART OF
    // SPEECH — "a minor rename", "the batched minors" (#2822), the
    // `npm-minor-and-patch` dependabot group (#2813). Narrowing by article
    // ("a minor") fails on all three. What separates the senses is that the
    // person sense never stands alone: it sits beside the boundary it is about.
    // So the word must be co-located with one, within a sentence, either side.
    rx: /(?<![-\w])minors?(?![-\w])(?=[^.!?]{0,90}\b(?:adults?|adult-only|ages?|aged|child(?:ren)?|gates?|life[-\s]stage|profiles?)\b)|\b(?:adults?|adult-only|ages?|aged|child(?:ren)?|gates?|life[-\s]stage|profiles?)\b[^.!?]{0,90}(?<![-\w])minors?(?![-\w])/i,
    why: "a claim about what a child's profile may record or see",
  },
  {
    term: "infant / newborn",
    rx: /\b(?:infants?|newborns?|neonat\w*)\b/i,
    why: "the population the life-stage gates most need to resolve correctly",
  },
  {
    term: "life stage",
    rx: /\blife[-\s]stages?\b/i,
    why: "the safety gate itself, or the criterion deciding who carries it",
  },
  {
    term: "age gate",
    rx: /\bage[-\s](?:gates?|gated|gating|checks?|thresholds?)\b/i,
    why: "a gate that reads an age — the value and the gate are different files",
  },
  {
    term: "adult-only",
    rx: /\badult[-\s]only\b/i,
    why: "the restricted-content boundary a wrong age walks straight through",
  },
  {
    term: "credential",
    rx: /\bcredentials?\b/i,
    why: "a disclosure boundary — a shape that gets past it is on a user's screen",
  },
  { term: "secret", rx: /\bsecrets?\b/i, why: "same disclosure boundary" },
  {
    term: "redact",
    rx: /\bredact\w*/i,
    why: "the masking itself; under-masking discloses, over-masking destroys",
  },
  {
    // `PHI` NAMES THE GATE HERE, not the hazard (#5275). Uppercase-and-unhyphenated
    // was meant to leave `phi-scan` alone; the repo writes the gate a dozen other
    // ways — `PHI scan`, `PHI checks`, `PHI and format`, and the scan's own "no
    // likely-real PHI in 5566 files", which the dispatch brief REQUIRES a body to
    // quote. Over PRs #4144-#5282 the bare term fired 25 times, every one of them
    // the gate's name or its output and none a claim about a person's data, and 13
    // of those flipped a path-ordinary PR from `ordinary` to CONSULT.
    //
    // NO SECTION RULE REACHES THEM, which is why this is narrowed at the TERM.
    // #4842 keyed the transcript on a `Gates` heading and #5272 spelled it
    // `Verification`; most of the other 24 are the author's own one-line summary
    // under no heading at all, so they are not quotation in any form a parser
    // could recognise. What separates the senses is the same thing that separated
    // `minor`'s: the hazard sense never stands alone — PHI is only a disclosure
    // when something MOVES it, which is what this term's `why` has always said.
    // Narrowed, it fires 0 times across those same 600 PRs and still reads every
    // disclosure claim in the test beside it.
    term: "PHI",
    rx: PHI_DISCLOSURE,
    // THE BET, STATED, so the next editor inherits the number and not an
    // impression of one: narrowed on 2026-09-05, when the bare term scored 25
    // hits and NOT ONE true positive over PRs #4144-#5282. If a later window is
    // also empty, rule (2) above settles this term on evidence rather than on
    // the inertia of having always been in the table.
    why: "protected health information leaving the surface it was recorded on — narrowed 2026-09-05 to that movement, the bare term having scored 25 hits and 0 true positives over PRs #4144-#5282",
  },
  {
    term: "contraindication",
    rx: /\bcontraindicat\w*/i,
    why: "a warning the app already had the facts to give and may now drop",
  },
  {
    term: "upper limit",
    rx: /\b(?:upper[-\s]limit|tolerable[-\s]upper)\w*/i,
    why: "the arithmetic behind a warning — never computed is as silent as never sent",
  },
  {
    // NOT bare `dose`: this app logs doses all day (`the dose chip`, `3 doses
    // due`, `dose history`). Only the phrases that are about a dose going WRONG.
    term: "dose safety",
    rx: /\b(?:overdose\w*|(?:missed|double|maximum|max|toxic)[-\s]dose\w*|dose[-\s](?:reminders?|escalations?|ceilings?|limits?))\b/i,
    why: "the safety signal whose justification is not effectiveness",
  },
  {
    term: "warning",
    rx: /\bwarnings?\b/i,
    why: "something the user is told; a warning that stops firing fails silently",
  },
  {
    // NOT bare `flag`: `flagged this family`, `the build-time flag`, `flags —
    // never fixes`. Only the clinical sense.
    term: "red flag",
    rx: /\bred[-\s]flags?\b/i,
    why: "the escalation path, which must not quietly stop escalating",
  },
];

// The vocabulary tier applies to a diff that CHANGES CODE THE APP SHIPS. This is
// the same question the registry asks — what does a bug here disclose or decide —
// applied to scope rather than to a filename: a diff confined to docs/, e2e/,
// scripts/, CI config or test files decides nothing at runtime, and its prose is
// disproportionately ABOUT the machinery (the stall `warning`, the scan that
// `flags` 91 sites, `phi-scan`), so it is where a text rule reads worst. Measured
// on the same 100-PR window: scoping here took the false-CONSULT rate from 24.7%
// of path-ordinary PRs to 6.8%.
//
// A PR that touches a shipped module AND its tests is in scope through the module.
// The hole this leaves is a TEST-ONLY diff that weakens a safety test; the path
// tier does not see that either, and it is recorded rather than papered over.
const SHIPPED_CODE = /^(?:lib|app|components)\/|^middleware\.ts$/;
const TEST_FILE = /(?:^|\/)__(?:tests|db_tests|action_tests)__\/|\.test\.tsx?$/;

export function shipsRuntimeCode(files) {
  return files.some((f) => SHIPPED_CODE.test(f) && !TEST_FILE.test(f));
}

// A DIFF THAT ONLY REMOVES ASSERTIONS IS NOT "A DIFF THAT DECIDES NOTHING" (#3044).
//
// The scope rule above is true of what it examines and false of what actually
// protects this system: the safety gates here are substantially enforced BY TESTS.
// `lib/__tests__/adult-only-writes-scan.test.ts` is what keeps a write core in
// `ADULT_ONLY_WRITE_CORES`; `profile-scoping.test.ts` is what keeps a query's
// `profile_id` filter. A PR that weakens one has changed no runtime line and has
// removed a guard, and came back `ordinary`.
//
// WHY DELETIONS AND NOT TEST FILES. #3039 scoped test files out with a number: on the
// tuning window, admitting every test file takes the false-CONSULT rate from 6.8% to
// 12.3%, and the five it adds are all tooling PRs whose prose is ABOUT machinery.
// Re-measured on both of that ruling's windows, a NET `expect(` DELETION costs
// nothing at all — 6.8% tuning and 5.8% held out, identical to the rule it widens.
// It brings exactly ONE of 201 merged PRs into scope that the tier could not see:
// #2963, "Remove useless test assertions", 26 assertions removed across 12 files.
//
// WHY NOT A NAMED SET OF SCAN TESTS. Measured at the same zero cost, so it buys no
// accuracy — and it is a list that has to be maintained, and that goes stale silently
// the first time a gate is enforced by a test nobody added to it.
//
// WHAT THIS STILL DOES NOT CATCH, recorded rather than papered over, in the tradition
// of the hole it closes: scope only lets the TEXT tier look. #2963 is in scope under
// this rule and still `ordinary`, because its own prose names no safety term. A
// deletion described in neutral words stays invisible, and no scope rule fixes that.
/**
 * @param {string[]} files
 * @param {Record<string, string>} [patches] filename -> unified diff, when the
 *   caller has it. Absent means the pre-#3044 filename-only scope rule.
 * @returns {string[]}
 */
export function weakenedTests(files, patches) {
  return files.filter(
    (f) => TEST_FILE.test(f) && netExpectDelta(patches?.[f]) < 0
  );
}

/** Assertions a unified-diff hunk adds, minus the ones it removes. */
function netExpectDelta(patch) {
  let delta = 0;
  for (const line of (patch ?? "").split("\n")) {
    const n = (line.match(/expect\(/g) ?? []).length;
    // `+++`/`---` are the file headers, not content.
    if (line.startsWith("+") && !line.startsWith("+++")) delta += n;
    else if (line.startsWith("-") && !line.startsWith("---")) delta -= n;
  }
  return delta;
}

// Prose only. A PR body carries four things this tier must not read: fenced
// blocks (pasted gate transcripts and command output), the PR template's own
// checklist (`- [x] No PHI in code, fixtures, seed`, on 12 of 73 path-ordinary
// PRs), the GATE RESULTS SECTION, and the generated footer. None of them is a
// claim the author is making about the change.
//
// THE GATE SECTION IS A TRANSCRIPT WHEREVER IT IS SPELLED (#4842). This tier
// already dropped `=== GATE` lines and fenced output, and PR #4881 walked through
// the gap between them: its results are a markdown TABLE under `## Gates`, and the
// row "| `phi-scan` | OK — no likely-real PHI in 5440 files |" — a gate reporting
// it found NOTHING — came back CONSULT as a claim that PHI was leaving a surface.
// The heading is the repo's own idiom, not an invention: of the 96 PRs merged to
// 2026-09-03 (#4652–#4881), 24 carry a gate section and all 24 spell it `Gates`
// (`## Gates`, `## Gates (all on this head)`, `### Gates`). Everything under it,
// to the next heading of the same or higher level, is machinery output.
export function claimProse(markdown) {
  const kept = [];
  let fenced = false;
  let gateDepth = 0;
  for (const raw of (markdown ?? "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = /^\s*(#{1,6})\s/.exec(line);
    if (heading) {
      const depth = heading[1].length;
      if (/^\s*#{1,6}\s*(?:the\s+)?gates?\b/i.test(line)) {
        gateDepth = depth;
        continue;
      }
      if (gateDepth && depth <= gateDepth) gateDepth = 0;
    }
    if (gateDepth) continue;
    if (/^\s*[-*+]\s*\[[ xX]\]/.test(line)) continue;
    if (/^\s*=+\s*GATE\b/i.test(line)) continue;
    if (/^\s*_Generated by \[Claude Code\]/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n");
}

const MAX_QUOTE = 300;

// The decision is made against the CLAIM, not the keyword. A tool that reports
// `matched: warning` sends the orchestrator to go read the PR, which is the exact
// cost this tier exists to remove — so it quotes the sentence the term sits in.
// Markdown blocks are the real unit here: a bullet wraps across source lines and
// is one claim, and a heading or a table row ends one as firmly as a full stop.
export function sentenceAround(text, index, matchLength) {
  const lines = text.split("\n");
  const starts = [];
  let at = 0;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  let li = 0;
  while (li + 1 < starts.length && starts[li + 1] <= index) li++;
  const blank = (i) => (lines[i] ?? "").trim() === "";
  // A list item is ENTERED and then stops the walk: its wrapped continuation
  // lines are part of the same claim. A heading, a quote or a table row is a hard
  // edge the walk never crosses — the line above "## Heading" is a different
  // section, and the row above a table row is a different row.
  const item = (i) => /^\s*(?:[-*+]\s|\d+[.)]\s)/.test(lines[i] ?? "");
  const edge = (i) => /^\s*(?:#{1,6}\s|>|\|)/.test(lines[i] ?? "");
  let first = li;
  while (first > 0 && !blank(first - 1) && !edge(first - 1) && !item(first)) {
    first--;
  }
  let last = li;
  while (
    last + 1 < lines.length &&
    !blank(last + 1) &&
    !edge(last + 1) &&
    !item(last + 1)
  ) {
    last++;
  }
  // Newline -> space is length-preserving, so offsets stay valid.
  const from = starts[first];
  const block = text
    .slice(from, starts[last] + lines[last].length)
    .replace(/\n/g, " ");
  const rel = index - from;
  let start = 0;
  for (const m of block.slice(0, rel).matchAll(/[.!?]\s+/g)) {
    start = m.index + m[0].length;
  }
  let end = block.length;
  const after = block.slice(rel + matchLength);
  const stop = /[.!?](?:\s|$)/.exec(after);
  if (stop) end = rel + matchLength + stop.index + 1;
  let quote = block.slice(start, end).replace(/\s+/g, " ").trim();
  if (quote.length > MAX_QUOTE) {
    // Window it around the term rather than truncating the tail off, so the
    // matched words are always inside what gets printed.
    const hit = quote.indexOf(block.slice(rel, rel + matchLength).trim());
    const head = Math.max(0, hit - Math.floor(MAX_QUOTE / 2));
    quote =
      (head > 0 ? "… " : "") +
      quote.slice(head, head + MAX_QUOTE).trim() +
      (head + MAX_QUOTE < quote.length ? " …" : "");
  }
  return quote;
}

// `sources` is [{ where, text }] — the PR title, its prose body, and the title
// and prose body of every issue it closes. One hit per term, first source wins.
export function vocabularyHits(sources) {
  const hits = [];
  for (const entry of SAFETY_VOCABULARY) {
    for (const source of sources) {
      const m = entry.rx.exec(source.text ?? "");
      if (!m) continue;
      hits.push({
        term: entry.term,
        why: entry.why,
        matched: m[0],
        where: source.where,
        quote: sentenceAround(source.text, m.index, m[0].length),
      });
      break;
    }
  }
  return hits;
}

/**
 * The whole decision, over facts a caller supplies — so it can be tested without
 * a network. Returns { verdict, exit, pathHits, vocabHits, weakened, scoped }.
 *
 * @param {{ files: string[], sources: { where: string, text: string }[],
 *   patches?: Record<string, string> }} input
 */
export function classify({ files, sources, patches }) {
  const pathHits = [];
  for (const file of files) {
    const rule = HIGH_STAKES.find((r) => r.glob.test(file));
    if (rule) pathHits.push({ file, why: rule.why });
  }
  // `patches` is optional: a caller with no diff text gets the path-and-filename
  // rules alone, which is what every pre-#3044 caller already had — and the diff
  // tier simply finds nothing, rather than reporting an absence it never looked for.
  const diffHits = diffSignals(files, patches);
  const weakened = weakenedTests(files, patches);
  const scoped = shipsRuntimeCode(files) || weakened.length > 0;
  // EVIDENCE ORDER, and it is the whole of #4842: what the diff DOES outranks what
  // the PR SAYS. A declared path and a moved authorization gate are both facts an
  // author cannot phrase away, so either one is MANDATORY. The prose tier survives
  // BELOW them, unchanged and still incapable of saying MANDATORY, because the five
  // PRs of #3030 are semantic misses no path or hunk rule reaches — a word remains a
  // reason to ASK, never evidence of a defect.
  const mandatory =
    pathHits.length > 0 || diffHits.some((h) => h.verdict === "MANDATORY");
  if (mandatory) {
    return {
      verdict: "MANDATORY",
      exit: EXIT.mandatory,
      pathHits,
      diffHits,
      vocabHits: [],
      weakened,
      scoped: true,
    };
  }
  const vocabHits = scoped ? vocabularyHits(sources) : [];
  const consult = diffHits.length > 0 || vocabHits.length > 0;
  return {
    verdict: consult ? "CONSULT" : "ordinary",
    exit: consult ? EXIT.consult : EXIT.ordinary,
    pathHits,
    diffHits,
    vocabHits,
    weakened,
    scoped,
  };
}

/** The PR's own claims, in the order a reader would weigh them. */
export function claimSources(pr, linkedIssues) {
  return [
    { where: `PR #${pr.number} title`, text: pr.title ?? "" },
    { where: `PR #${pr.number} body`, text: claimProse(pr.body) },
    ...linkedIssues.flatMap((issue) => [
      { where: `issue #${issue.number} title`, text: issue.title ?? "" },
      { where: `issue #${issue.number} body`, text: claimProse(issue.body) },
    ]),
  ];
}

/** Issue numbers this PR closes, from the keywords GitHub itself parses. */
export function closingKeywordIssues(text) {
  const found = [
    ...(text ?? "").matchAll(
      /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi
    ),
  ].map((m) => Number(m[1]));
  return [...new Set(found)];
}

// A GUARD MUST NOT FAIL INTO ITS PERMISSIVE ANSWER — the argument is stated in
// full at the top of this file, next to the exit codes it now governs. Every way
// this can fail to KNOW exits 2, joining the missing-token case: a curl that
// cannot run, a body that is not JSON, an error object where a list belongs (a
// deleted or mistyped PR number returns `{"message":"Not Found"}`, on which `.map`
// throws). Unreachable, unparseable and unauthorized are all "ask again", never
// "carry on" — and never CONSULT either, which is a decision about a PR the tool
// could read.
function fail(what) {
  console.error(
    `adversarial-review-brief: ${what} — cannot decide, so not deciding.`
  );
  process.exit(EXIT.cannotAnswer);
}

function gh(token, pathname) {
  let out;
  try {
    out = execFileSync(
      "curl",
      [
        "-sS",
        "-H",
        `Authorization: Bearer ${token}`,
        "-H",
        "Accept: application/vnd.github+json",
        `https://api.github.com/repos/FloorLamp/allos/${pathname}`,
      ],
      { encoding: "utf8", timeout: 30_000 }
    );
  } catch (err) {
    fail(`GET ${pathname} failed (${err.message})`);
  }
  try {
    return JSON.parse(out);
  } catch {
    fail(`GET ${pathname} returned a non-JSON body`);
  }
}

function main(argv) {
  const token = resolveReadToken();
  const prNumber = argv.find((a) => /^\d+$/.test(a));
  const checkOnly = argv.includes("--check");
  const force = argv.includes("--force");
  if (!prNumber || !token) {
    console.error(
      !prNumber
        ? "usage: adversarial-review-brief.mjs <pr-number> [--check] [--force]"
        : 'No GH_TOKEN/GITHUB_TOKEN and no authenticated gh — cannot read the PR. Re-mint via add_repo access:"push".'
    );
    process.exit(EXIT.cannotAnswer);
  }

  const pr = gh(token, `pulls/${prNumber}`);
  if (!pr || typeof pr.number !== "number") {
    fail(
      `PR #${prNumber} did not resolve (${pr?.message ?? "no number in the response"})`
    );
  }
  const files = [];
  const patches = {};
  for (let page = 1; page <= 10; page++) {
    const batch = gh(
      token,
      `pulls/${prNumber}/files?per_page=100&page=${page}`
    );
    if (!Array.isArray(batch)) {
      fail(
        `the file list for PR #${prNumber} came back as ${batch?.message ?? typeof batch}`
      );
    }
    for (const f of batch) {
      files.push(f.filename);
      if (f.patch) patches[f.filename] = f.patch;
    }
    if (batch.length < 100) break;
  }

  // A linked issue carries the claim as often as the PR does — #3004's exemption
  // criterion and #3028's unit bug are both stated hardest in the issue.
  const linkedIssues = [];
  for (const n of closingKeywordIssues(`${pr.title}\n${pr.body ?? ""}`)) {
    const issue = gh(token, `issues/${n}`);
    if (issue && typeof issue.number === "number") linkedIssues.push(issue);
  }

  const { verdict, exit, pathHits, diffHits, vocabHits, weakened, scoped } =
    classify({
      files,
      sources: claimSources(pr, linkedIssues),
      patches,
    });

  // The reasoning is printed so it can be CHECKED, not trusted: every diff signal
  // names the file, the hunk header and the changed line that earned it, so an
  // orchestrator reads the same evidence the tool read (#4842).
  const printDiff = (tier) => {
    for (const h of diffHits.filter((d) => d.verdict === tier)) {
      console.error(`  [${h.signal}] ${h.file} ${h.hunk} — ${h.why}`);
      console.error(`      ${h.line}`);
    }
  };

  if (verdict === "MANDATORY") {
    console.error(`MANDATORY — PR #${prNumber} (${files.length} files):`);
    for (const h of pathHits) {
      console.error(`  [declared path] ${h.file}  (${h.why})`);
    }
    printDiff("MANDATORY");
  } else if (verdict === "CONSULT") {
    console.error(
      `CONSULT — no declared path and no authorization signal in PR #${prNumber} (${files.length} files), but something here decides more than it says.`
    );
    if (weakened.length) {
      console.error(
        `  in scope because it REMOVES assertions from: ${weakened.join(", ")}`
      );
    }
    console.error(
      "An ORCHESTRATOR decides whether the lane runs. Read this evidence, not the terms:"
    );
    printDiff("CONSULT");
    for (const h of vocabHits) {
      console.error(`  [${h.term}] ${h.where} — ${h.why}`);
      console.error(`      "${h.quote}"`);
    }
  } else {
    console.error(
      `ordinary — no declared path, nothing in the hunks, and no safety vocabulary in PR #${prNumber} (${files.length} files${scoped ? "" : "; the diff ships no runtime code"}).`
    );
  }
  if (checkOnly) process.exit(exit);
  if (verdict !== "MANDATORY" && !force) process.exit(exit);

  // ---- the refuter brief ----------------------------------------------------

  const body =
    (pr.body ?? "").trim() ||
    "(the PR has no body — its commits' messages carry the claims)";
  // The refuter is handed the SAME evidence the verdict was reached on — file and
  // hunk first, so the attack starts at the line rather than at the category.
  const surfaceLines = [
    ...pathHits.map((h) => `- ${h.file} — ${h.why}`),
    ...diffHits.map((h) => `- ${h.file} ${h.hunk}  ${h.line}\n  (${h.why})`),
    ...vocabHits.map((h) => `- ${h.term} (${h.where}) — ${h.why}`),
  ];
  const surface = surfaceLines.length
    ? surfaceLines.join("\n")
    : "- (dispatched by --force; the surface is the orchestrator's judgement)";

  console.log(`You are the ADVERSARIAL REVIEWER for FloorLamp/allos PR #${prNumber}
("${pr.title}"). You are a second, independent lane — the ordinary review
already happened. Your ONLY job is to try to BREAK this change. You do not
summarize it, you do not praise it, and you do not trust its tests: a test the
author wrote proves the author's model of the bug, not the absence of others.

This diff touches a surface where a miss corrupts stored data, crosses the
login/profile authorization boundary, or silences a safety signal:
${surface}

THE CLAIMS TO ATTACK (the PR body, verbatim — every factual claim in it is a
target; a claim you cannot refute after honestly trying is CONFIRMED):
---
${body}
---

METHOD
- Read-only posture: work in a fresh worktree at the PR's MERGE ref
  (git fetch origin pull/${prNumber}/merge && git worktree add $SCRATCH/wt-refute-${prNumber} FETCH_HEAD).
  You never push to this branch and never open a PR; your deliverable is a report.
  THIS OVERRIDES ANY WORKTREE PATH YOUR DISPATCH MESSAGE NAMES. An attack mutates
  production files; the authoring lane is usually still committing in its own tree,
  and one \`git add -A\` there commits your deleted bound onto the landing candidate.
  That is not hypothetical -- on #4312 a lane found its date bound deleted under it
  mid-round, twice, because the dispatch pointed this brief at the lane's live tree.
  If you were handed a path, build your own anyway and say so in your report.
- For each claim: construct the CONCRETE input, database state, or call sequence
  that would falsify it, and run it (db tier / pure tier / a scratch script
  against an in-memory database). "I read the code and it looks right" is not a
  verdict — either you executed an attack or you say the attack you could not
  build and why.
- IF THE DIFF CLAIMS REDUNDANCY, DELETE EACH HALF SEPARATELY AND RUN THE SUITE.
  "Two barriers, and neither is trusted on its own" is a claim about the tests,
  not about the code, and it is the one claim a reading can never check. On the
  fourth pass over #2994 both halves of a logout guard — the framework rethrow
  and the server probe — turned out to be individually deletable with the whole
  shipped suite green, because the one test that covered the path could not tell
  which half had stopped it. A redundancy nothing observes is one mechanism and
  a comment. Each half needs an assertion that goes RED when only that half is
  removed; show the mutant red, not the fixed head green.
- Attack the boundaries the diff's own tests skip: the state that exists on a
  REAL upgraded database but not in a fresh fixture; the second concurrent
  writer; the rolled-back build meeting the new schema; the row a sweep or
  cleanup path must not orphan; the caller that reaches a core WITHOUT the new
  guard (grep for every caller — the calling surface is not evidence).
- Migration diffs specifically: idempotency under re-run, the parallel-boot-orchestrator
  race, order divergence, every historical schema shape the probe claims to
  handle (a probe that cannot tell 'predates the table' from 'typo' is the #2444
  defect), and what a HALF-APPLIED failure leaves behind.
- Auth/notification diffs specifically: the unauthorized POST straight to the
  action, the profile id swapped for an accessible-but-wrong one, and the safety
  signal (dose reminder, missed-dose escalation) that a new suppression path
  could reach — those must be shown unreachable, not assumed.

REPORT (your final message, nothing else):
- Per claim: CONFIRMED (with what you ran) or REFUTED (with the exact failing
  input/sequence and its output, reproducible by the orchestrator).
- Any defect found OUTSIDE the claims, same evidence standard.
- The attacks you could not build, and what would be needed to run them.
- No verdict inflation: if everything held, say so plainly — a clean report
  after honest attack is the lane working, not a wasted dispatch.`);
}

// Run as a script, importable as a module — the same shape dispatch-brief.mjs
// uses. Without this guard, importing the file to test the classifier would run
// the CLI, which curls GitHub and calls process.exit() out from under vitest.
if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2));
}
