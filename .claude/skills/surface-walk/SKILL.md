---
name: surface-walk
description: Combinatorial audit of a UI surface whose content is conditional — enumerate every conditionally-rendered block and its predicate, collapse the combination space into meaningful states, judge each state's coherence, and rank the inconsistencies. Use whenever asked to review "all the states/combinations" of a page, whether a conditional surface "makes sense", why a page looks different for different users/days, or to audit a dashboard, hero, strip, banner stack, or empty-state behavior — even if the ask is phrased as "what appears when" or "is anything inconsistent here".
---

# Surface walk

A conditional surface (dashboard, hero band, notification stack) is really 2^n
surfaces — one per combination of its predicates. Bugs hide in the combinations
nobody rendered: a rationale that only holds when a sibling happens to render, two
bands that always co-occur and say the same thing, a control that behaves unlike
its twins. This skill walks the whole space instead of the one state on screen.

Work from the CODE, not screenshots — a screenshot shows one state; the predicates
show all of them. (For measured px/tap evidence on specific states, the
`ux-walkthrough` skill's mobile audit complements this.)

## 1. Inventory the blocks

Read the surface's component top-to-bottom and list every block in RENDER ORDER
with its exact predicate, including viewport conditions (`hidden md:block`).
Two things people skip, where most findings live:

- **Open every child component and record its empty behavior.** `return null`
  and "renders a quiet all-clear card" are different worlds: a null child is an
  axis of the combination space; an always-something child is a fixed anchor.
  Don't trust the parent's conditional — the child may have its own.
- **Capture the stated rationale, not just the condition.** Design comments and
  issue references ("the date survives on the strip's corner", "surfaces near
  the illness hero") are claims that must hold in EVERY state, and they are
  routinely written from the one state their author was looking at. A rationale
  that references a sibling is false in every state where that sibling is absent.

## 2. Reduce to axes

Group the predicates into independent axes with small value sets (e.g. illness
phase: well / open / closed≤7d / closed 8–14d; login scope: single / multi;
attention: empty / items). Then find the couplings — they're where redundancy
and orphaning hide:

- **Window subsets**: if block A's time window is a subset of block B's
  (7-day reopen ⊂ 14-day promo), A's presence GUARANTEES B's — they always
  co-occur, so judge them as one unit, not two.
- **Implications**: predicate A ⇒ predicate C (promo requires multi-profile ⇒
  household strip always present alongside it) prune impossible states and
  prove that a proposed anchor always exists.
- **Promotion/dedup couplings**: a card that renders in slot X _or_ slot Y needs
  its one-render-never-two guard traced, and its position-jump judged.

## 3. Collapse and enumerate

2^n literal combinations are noise. Enumerate the MEANINGFUL states: the quiet
minimum, each axis's single-signal state, every guaranteed co-occurrence from
step 2, and the realistic worst-case stack. That's usually 8–12 named states.
Present them as a table — state, resulting stack (in render order, per the
target viewport), verdict — so absences are as visible as presences.

## 4. Judge each state

Apply the house lenses (AGENTS.md conventions) per state, not per page:

- **Priority claim vs treatment**: does the most-relevant content get the most
  room? (A "most relevant right now" strip that gives its cards HALF the width
  the same widgets get in the grid below inverts its own claim.)
- **One question, one home**: do two bands in this state answer the same
  question? Guaranteed co-occurrences (step 2) make this structural, not rare.
- **Convention twins**: does every control behave like its siblings app-wide?
  A dismissal that doesn't persist when every other X does reads as a bug even
  if it was a deliberate carve-out — check the referenced issue before calling
  it one, then judge whether the carve-out still earns its inconsistency.
- **Rationale still true?**: re-check every step-1 rationale claim in this
  state. Orphaned affordances (a link "near the hero" in a state with no hero)
  and vanished information (a date that "survives on the strip" when the strip
  is null) are this lens's yield.
- **Bounded?**: per-member / per-item repetition needs a bound (household size
  counts as one; unbounded lists don't).

What usually holds up — and should be said so the report is refutable: ordering
that matches declared priority, blocks that self-remove cleanly, caps that hold.
Name the states that are GOOD; a findings-only report can't be trusted on coverage.

## 5. Rank, verify, then decide

Rank findings by user damage, and verify each against the code with `file:line`
before reporting — a claimed inconsistency that's actually a documented decision
(check comments' issue refs) gets reported as "deliberate, here's the tension",
not as a bug. Distinguish three tiers in the write-up:

1. **Broken promise** — a stated design intent the code doesn't deliver in some
   state (highest confidence, file first).
2. **Structural redundancy** — guaranteed co-occurring bands answering one
   question; propose the fold and prove the anchor exists in every state.
3. **Deliberate carve-out under tension** — document the trade and let the
   owner re-decide; don't silently "fix" it.

Deliverable: the state table + ranked findings. Anything ambiguous or with a
real design fork goes to the owner as a question BEFORE an issue is filed;
issues are filed only fully-determined (this repo's standing rule).

## Worked example (the dashboard walk, 2026-07)

The mobile dashboard stack H→N→S→R→P→C→O→HS→G collapsed to 9 states across
axes {illness phase, login scope, attention, now-cards, recap, onboarding}.
Yield: the phone's date rendered only inside a strip that's null on quiet days
(broken promise, #1413-C's own rationale); the Now strip forced two half-width
cards on phones while the grid gave the same widgets full width (priority
inversion → #1547); the reopen X was the app's only non-persisting dismissal
(convention twin → #1548); the 7d⊂14d window subset guaranteed a three-band
household stack (structural redundancy → #1549, with the multi-profile ⇒
household-strip implication proving the fold's anchor always exists). The
ordering itself, the accordion bounds, and the strip cap all held up — reported
as such.
