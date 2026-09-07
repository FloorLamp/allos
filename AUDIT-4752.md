# AUDIT — #4752 acceptance criteria against `main`

Audited at `origin/main` = `3a1fee7e92d7b58468cf2e34023477f8dca94ed0`
("Say each fact once on the fever nudge and the illness cockpit (#5467)").
Branch `cockpit-audit-4752`, worktree `wt-cockpit-4752`, base pinned to that SHA.

This is a **checkpoint artifact**, not part of any final diff. It records the
premise the lane worked from before touching a line.

Criteria are the six bullets under `## Acceptance criteria` in the issue body,
read together with the 2026-09-03 amendment appended to that body (§6 loses its
condition; §7 is dropped from scope).

---

## Verdict table

| #   | Criterion                                                                                                                                                                                                            | Verdict           | Citation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Desktop cockpit renders the blessed anatomy: constrained card, recovery header with promoted Feeling better, one-line symptom row, chip meds with one status line (component tests per region; e2e at 1280+ and 390) | **met**           | see clause table below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | Each expansion opens in place; no navigation, no layout shift outside the panel (geometry assertion)                                                                                                                 | **met**           | `e2e/dashboard-illness-phase5.spec.ts:652-671` — boxes of the header, symptom row and chip row captured before the chip tap and asserted `toEqual` after; `expect(page.url(), "the card never navigates").toBe(url)` at :669, and `expect(after).toEqual(before)` at :671. Mechanism: `components/illness/IllnessMedicationLogger.tsx:184-217` (panel rendered as a sibling below the chip row, `openMedId` client state, no navigation) and `components/illness/SymptomLogBar.tsx:755-759` (the picker panel, a sibling directly beneath the row) / `IllnessCockpitBody.tsx:31-33`. Ran green (8/8, see gates below).               |
| 3   | The med panel shows band basis and per-med redose in rolling-24h phrasing; collapsed chips show neither                                                                                                              | **partially met** | **met:** the rolling-24h redose clause and the "collapsed chips show neither" clause. **unmet:** the band-basis clause. Detail below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 4   | Cross-profile Now renders subject groups with labels; single-subject renders none; relevance ranks within groups (unit tests on the sort contract)                                                                   | **met**           | `lib/dashboard-relevance.ts:667-673` (`groupRankedBySubject` over the Now selection, keyed by `nowSubjectKey` at :296); `lib/rank-core.ts:229-244` (rank survives inside a group; a group's seat is its best member's; a single group returns `null`); `components/dashboard/NowCards.tsx:139-156` — `opensGroup` at :139, the `now-subject-label` `li` at :142-156, drawn only at a subject boundary and never when `row.subject` is null. Unit tests on the contract: `lib/__tests__/rank-core.test.ts:187-224` (the `it.each` table, incl. "one subject is not a grouping" → `null`) and :226-238 (rank survives inside a group). |
| 5   | No "Mark taken"/"Taken now" copy remains in the Now section; no time affordance other than the clock door (scan-level assertions)                                                                                    | **met**           | `e2e/dashboard-illness-phase5.spec.ts:685-711` — a **rendered** sweep of every `button` inside `now-strip`, asserting `/mark taken\|taken now\|earlier dose/i` matches nothing and that `/happened earlier/i` matches at least one (the non-vacuity control). The Now dose control is `components/DoseConfirmButton.tsx` mounted at `app/(app)/page.tsx:1486-1497` with `ariaLabel={\`Take ${item.title}\`}`. Source-level scans: `lib/**tests**/chip-residual.test.ts`(retired verb copy) and`lib/**tests**/time-input-scan.test.ts:429-521` (the clock glyph is the only spelling of the statement toggle). Ran green.             |
| 6   | `npm run lint`, `npm run typecheck`, `npm test` green; height e2e green                                                                                                                                              | **met**           | gate output below — all four run, all green, at this exact SHA with a zero diff.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

---

## Criterion 1, clause by clause

| Clause                                                | Verdict | Citation                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| constrained card (~880px, centered, never full-bleed) | met     | `components/dashboard/IllnessNowGroup.tsx:183` — `mx-auto w-full min-w-0 max-w-[880px]`; reasoning at :177-182. Asserted as a _relationship_ (inset + equal gutters against its own column), not only a number, at `e2e/dashboard-illness-phase5.spec.ts:636-647`.                                                                                                               |
| recovery header with promoted "Feeling better"        | met     | `components/illness/CockpitRecoveryHeader.tsx:66-125` (ring, headline, Day-N tag, one summary line, `action` slot at :124); the action is `CockpitEndEpisode` passed in at `components/illness/IllnessCockpitBody.tsx:98-106`. Component test: `components/__tests__/cockpit-anatomy.test.tsx:73-119`, with the promotion asserted as containment inside the header at :106-108. |
| one-line symptom row                                  | met     | `components/illness/SymptomLogBar.tsx:678-753` — one `symptom-log-actions` flex row holding both add buttons, the empty state and the Today/Yesterday toggle. Component test: `components/__tests__/symptom-two-pieces.test.tsx:484-498`, asserted as **containment** (`row.contains(...)`) rather than as a count, plus "the row is the bar's first child".                     |
| chip meds with one status line                        | met     | `components/illness/IllnessMedicationLogger.tsx:122-182` — `cockpit-med-chips` flow row, `cockpit-med-more` tail fold at :143-152, and exactly one `cockpit-med-status` paragraph at :175-182 fed by `medChipsStatusLine` (`lib/redose-format.ts:278-311`). Component test: `components/__tests__/cockpit-anatomy.test.tsx:176-200`.                                             |
| component tests per region                            | met     | `components/__tests__/cockpit-anatomy.test.tsx` (header + meds), `components/__tests__/symptom-two-pieces.test.tsx:484` (symptom row), `lib/__tests__/redose-format.test.ts:487` (the status line's strings), `lib/__tests__/illness-episode-format.test.ts:895` (the header's three strings).                                                                                   |
| e2e at 1280+ and 390                                  | met     | `e2e/dashboard-illness-phase5.spec.ts:594-597` — the geometry/grammar test is a loop over `{width:1280,height:900}` and `{width:390,height:844}`.                                                                                                                                                                                                                                |

---

## Criterion 3 in full — the one criterion not fully met

The criterion has three clauses. Two are met; one is not, and it is not this
lane's to build.

**Clause (a) — "per-med redose in rolling-24h phrasing": MET.**
The panel renders `prn-redose-line` at `components/medications/QuickLogPrnControl.tsx:308-315`
(the `layout="detail"` arm the cockpit mounts), fed by
`components/illness/IllnessMedicationLogger.tsx:209` → `open.row.redoseLine` →
`prnRowStatus` (`lib/redose-format.ts:321`, redose line built at :349) → `redoseCardLabel`
(`lib/redose-format.ts:138-158`), whose every branch reads
"… · N of M **in 24h**" (`countFragment`, `lib/redose-format.ts:47-53`;
`exposureFragment`, :76).

**This contradicts the dispatch premise, and the premise's own evidence is what
misleads.** `git grep -inE 'rolling.?24' -- '*.ts' '*.tsx'` does return nothing
(exit 1 — re-run here and confirmed). But that token is **how the issue words the
construct, not how the repo spells it**: this repo writes the rolling window as
`in 24h`, and the copy half of #4686 has already landed —
`lib/redose-format.ts:43-45` says so by number ("IT SAYS 'in 24h' BECAUSE THAT IS
THE WINDOW IT COUNTS (#4686). … the count behind it is now gathered over the
trailing 24 hours"), and the gather agrees:
`lib/queries/intake/adherence.ts:1785`, `:1833`, `:1950` all name the
TRAILING-24h window. #4686 is still open, but the phrasing this criterion asks
#4752 to _render_ exists on `main` today.

**Clause (b) — "collapsed chips show neither": MET.**
A collapsed chip renders only the medication's name
(`components/illness/IllnessMedicationLogger.tsx:127-142`); `prn-day-label` and
`prn-redose-line` exist only inside the opened panel. Asserted directly at
`components/__tests__/cockpit-anatomy.test.tsx:194-197`.

**Clause (c) — "the med panel shows band basis": UNMET, and BLOCKED on #4686's
sibling #4713.**
The line that should carry it is
`components/medications/QuickLogPrnControl.tsx:299-315` — the detail arm's body,
which draws the eyebrow, the day label and the redose line and nothing else. No
weight-band string reaches it: the panel's own comment says so at
`components/illness/IllnessMedicationLogger.tsx:59-61` ("the weight-band basis
**once #4713 computes one**").

How this was established, in three passes:

1. `git grep -inE 'band basis|weight.?band|lb band|weight from' -- '*.ts' '*.tsx'`
   returns no producer of a dose-time band string — every hit is the intake
   _form_'s picker (`components/IntakeItemForm.tsx:963`, `:1118`, `:1181`,
   `components/medications/PediatricDoseBandPicker.tsx`), a comment, or a fixture.
2. The pure lookup **does** exist — `bandForWeightLbs` and `bandRangeLabel`
   (`lib/prn-dosing.ts:82`, `:97`), `pediatricDoseSuggestion` (`:212`) — but
   `git grep -ln 'from "@/lib/prn-dosing"'` lists no dose-time consumer: the
   callers are the medications page, the intake form, `intake-form-context` and
   `intake-prefill`. Nothing on the PRN tap path
   (`prnRowStatus`, `QuickLogPrnControl`, `IllnessMedicationLogger`) reaches it.
3. **#4713 ("The pediatric weight band never runs at dose time") is OPEN**, and
   its fix item 1 is this criterion's own sentence: _"the dose row's offered
   amount is band-derived at render … The row states its basis ('160 mg · 24–35
   lb band')."_ #4752's own `## Out of scope` says the same from the other side:
   _"band-at-tap mechanics (#4713) — this issue renders what they compute."_

So the mechanics do not exist on `main`, and this is reported blocked rather
than faked: inventing a band string here would print a dose basis nothing
computed, on a pediatric antipyretic, at the 2 AM moment both issues were
written for. That is the worst outcome available.

---

## Gate results (criterion 6), verbatim

`bash scripts/orchestration/run-gates-recorded.sh cockpit-audit-4752`, run from
the worktree root at a **zero diff** against `3a1fee7e9`, so this is `main`'s own
verdict. Log `/root/.local/state/allos-work/gates-cockpit-audit-4752.log`
(`grep -aPc '\x00'` → 0; no foreign worktree path in it).

```
GATES EXIT=0
=== GATE: lint ===
=== GATE lint: PASS ===
=== GATE: typecheck ===
=== GATE typecheck: PASS ===
=== GATE: test (pure, per-test ceiling 60000 ms) ===
=== GATE test (pure, per-test ceiling 60000 ms): PASS ===
=== GATE test:db: SKIPPED (nothing the DB tier imports changed vs 3a1fee7e92d7) ===
=== GATE e2e-hygiene: SKIPPED (nothing under e2e/ changed vs 3a1fee7e92d7) ===
=== GATE: phi-scan ===
=== GATE phi-scan: PASS ===
=== GATE: format (LAST) ===
=== GATE format (LAST): PASS ===

ALL GATES PASSED (format included). This script does not run Playwright.
```

Height e2e —
`E2E_PORT=5400 npx playwright test e2e/button-height-floor.mobile.spec.ts --retries=0`:

```
EXIT=0
  28 passed (3.0m)
```

The cockpit's own e2e, which is the citation behind criteria 1, 2 and 5 —
`E2E_PORT=5400 npx playwright test e2e/dashboard-illness-phase5.spec.ts --retries=0`:

```
EXIT=0
  8 passed (27.1s)
```

(both `[7/8]` and `[8/8]` are the desktop and phone arms of the measure +
in-place + one-grammar test.)

---

## Two premises checked rather than inherited

- **§7 is live behaviour, not stale prose** — confirmed. `app/(app)/page.tsx:1486`
  cites "#4752 item 7" over a real `DoseConfirmButton` mount whose `ariaLabel` is
  `Take <title>`; the rendered Now-section sweep at
  `e2e/dashboard-illness-phase5.spec.ts:702-705` passes. Every surviving
  "Mark taken" string in the tree is outside the Now section: `/upcoming`
  (`app/(app)/upcoming/page.tsx:1598`, driven by `e2e/multi-view.spec.ts:193`,
  which records at :188-190 that this row is deliberately unmigrated per #4753
  ruling 4), or a comment, or a scan's own fixture.
- **The issue's file paths are stale** — confirmed; the components live under
  `components/illness/`.

## Conclusion

Five of six criteria are met. The sixth (criterion 3) is met in two of its three
clauses; its band-basis clause is **blocked on #4713**, whose mechanics are not
on `main`. Nothing in this issue is both unmet and buildable today, so the lane
changes no behaviour.
