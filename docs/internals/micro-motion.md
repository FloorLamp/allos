# Micro-motion: the small moves the app is allowed to make

The app is almost entirely static, and that is the calm identity working — no
garnish, nothing looping, nothing moving without a gesture. Two classes of motion
are allowed out of that stillness.

**INFORMATION motion** answers **"did that work?"** or **"what just arrived?"**
inside the interface, faster and quieter than a toast. It carries a fact, and is
held to the same standard as copy.

**CONTINUITY motion** (#3676) answers nothing. Its job is that **the eye keeps its
place through a change the reader caused** — a panel growing under the summary
they tapped. Switch it off and no fact is lost, only the reader's grip on where
they were. That is why rule 3's decoration sentence is scoped to the information
class and why a continuity motion declares [two different
things](#the-continuity-class) instead.

Seven information motions ship today (#2654, #2657, #3253, #3675). `slide` and `fold` are the two halves of one
gesture — a dismissal travelling, and the fold answering — and they are deliberately
**two** tokens, because they are two durations with two different justifications.

| Motion    | Token              | Duration             | What it says                                               |
| --------- | ------------------ | -------------------- | ---------------------------------------------------------- |
| `settle`  | `--motion-settle`  | 300 ms               | the control you tapped **became** its done state           |
| `count`   | `--motion-count`   | 250 ms               | a **quantity** changed, rather than a value being replaced |
| `slide`   | `--motion-slide`   | 300 ms               | the finding you dismissed **went somewhere**               |
| `tick`    | `--motion-tick`    | 180 ms               | the scrub crossed **into a different month**               |
| `promote` | `--motion-promote` | 300 ms               | a witnessed reading **moved into Now**                     |
| `arrive`  | `--motion-arrive`  | 200 ms               | due-and-usual offers **finished gathering**                |
| `fold`    | `--motion-fold`    | 500 ms (band-exempt) | the fold **caught** it — this is where to look             |

One ease curve for all seven, `--motion-ease`, decelerating: the move arrives and
settles, it never bounces back.

## The four rules

1. **150–300 ms.** Long enough to be read as a transition, short enough that a
   returning glance never waits on it. `MICRO_MOTION_MIN_MS`/`MAX_MS` are the band
   and `lib/__tests__/micro-motion.test.ts` fails a duration outside it — unless the
   motion carries an **argued exemption**. There is exactly one; see
   [The band's one exemption](#the-bands-one-exemption).
2. **Nothing loops.** A looping animation is an attention claim that never stops
   making itself, and a health app must not campaign at anyone. The token test fails
   an iteration count, `infinite` or `alternate` anywhere in the stylesheet's
   Micro-motion section, including every declared keyframe body.
3. **Reduced motion is the designed state, not a degradation.** Every motion in
   either class declares its `reducedEndState`: for an information motion, the same
   information arriving instantly; for a continuity motion, the end layout,
   instantly. **The second sentence is scoped to the information class**: a motion in
   THAT table whose meaning is lost when it is switched off was decoration and does
   not belong in it. A continuity motion is defined by having no meaning to lose, so
   that sentence cannot judge it — `preserves` and `causedBy` do that job instead.
   The rule is scoped, not weakened.
4. **Motion is never the only carrier.** Every information motion declares
   `carriedBy` — the text, attribute or colour that states the same fact for a reader
   who sees no motion at all, including a screen-reader user and a printed page. A
   continuity motion carries no fact, so it has none to declare.

Rules 3 and 4 are why the declaration tables exist. They are prose, so the test can
only check that the prose is there; what it prevents is a motion being added without
anyone having to answer either question.

## The continuity class

A continuity motion declares its own two required fields, and a row that leaves
either blank **cannot be constructed** — `continuityMotion(ms, preserves, causedBy,
reducedEndState)` throws, the same declare-or-argue shape `bandExemption()` and
`arguedExclusion()` use.

- **`preserves`** — the thing that stays continuous across the change, in the
  reader's terms ("the summary you tapped stays under your finger while the panel
  grows below it").
- **`causedBy`** — the reader's own action that licenses it. This is the guard that
  keeps "nothing moves without a gesture" true: a continuity motion with no gesture
  behind it is ambient movement and is refused. A network answer arriving unprompted
  is **not** a cause; the tap that requested it is.

Everything else is inherited from the information class unchanged: the 150–300 ms
band and its mechanical test (with the same `bandExemption()` shape if one is ever
argued — the pinned exempt-key list still names `fold` alone), nothing loops, the
single `--motion-ease` so the two classes cannot feel different, and
`reducedEndState`. That last one is why the class is safe: **a reader who turns
motion off gets exactly today's app.**

**What is still refused**, in both classes, stated so the continuity class cannot be
read as an opening: ambient or idle animation; anything looping; motion on a surface
the reader did not act on; decorative entrances on page load; motion that delays a
reader's next action — a control is interactive on the first frame of any continuity
motion, never after it.

## The band's one exemption

Rule 1 is mechanical, which is what turned "nothing lingers" from a promise into a
build property. Exactly one duration is outside it.

> **Owner ruling, 2026-08-13 (#2654).** The ~500 ms fold pulse keeps its duration.
> The 150–300 ms band gets an explicit, stated exemption for it rather than the pulse
> being shortened to fit. A dismissal travelling to its fold is a materially different
> motion from a tick settling in place; larger travel honestly wants more time, and
> compressing it to 300 ms would make it read as hurried where it should read as
> deliberate. **This ruling exempts the FOLD PULSE only.** Every other motion stays
> inside the band, and `nothing looping` is untouched.

The ruling also named the cost it was accepting: "a bare numeric exception with no
stated why is how a band stops being a rule and becomes a default that the next motion
argues it also deserves." So the exemption is not a number in a skip-list. It is a
**value that cannot be constructed without its argument** — `bandExemption(ms, ruling,
because)` throws on a blank ruling or a blank reason, the same declare-or-argue shape
`arguedExclusion()` uses in `lib/loggable-domains.ts` — and the test makes four
further things impossible:

- an exemption for a motion that **does not exist** (the table is typed
  `Partial<Record<MicroMotion, BandExemption>>`);
- an exemption that authorizes **some other duration** than the one the motion
  actually declares, so re-timing an exempt motion has to come back through the
  ruling rather than sliding under an old permission;
- a **stale** exemption — one whose motion has since come back inside the band — which
  fails rather than sitting there reading like a licence;
- a **second** exemption arriving quietly: the exempt key list is pinned in the test,
  so adding one means editing the line where the next reader asks what ruling
  authorized it.

The two halves of motion 2 are separately timed for exactly this reason. `slide` is
the dismissed row's own travel and stays inside the band; `fold` is the line
answering, and is the only thing the ruling exempts. Folding them into one token would
smuggle the row's travel out of the band too, and the test fails that.

## Where the halves live

- `lib/micro-motion.ts` — the pure half. Durations, the ease curve, the `MICRO_MOTIONS`
  and `CONTINUITY_MOTIONS` declaration tables, `microMotionPlan(kind, reduceMotion)` (which folds the preference
  into a duration and a class name, returning `0` and `""` under the preference).
- `app/globals.css`, `SECTION: Micro-motion` — the custom properties and the declared
  `.motion-*` classes, plus a `prefers-reduced-motion: reduce` block that neutralizes
  them. Belt and braces: the planner already returns no class, but a stylesheet that
  only works because its JS caller remembered to check is one refactor from animating
  someone who asked it not to.
- `components/RollingNumber.tsx` — renders authoritative digits immediately; its one
  `requestAnimationFrame` loop only retires the bounded scale-pulse receipt.
- `app/(app)/nutrition/FoodLogBar.tsx` — serving-chip settle and serving-count pulse.
- `components/quick-entry/QuickStoolForm.tsx` — type-chip settle and today's-count pulse.
- `app/(app)/timeline/TimelineScrubber.tsx` — the jump rail's bubble, beating once per
  month boundary a drag crosses.
- `components/dashboard/NowCards.tsx` — a witnessed reading promoted into Now.
- `components/QuickLogSheet.tsx` — due-and-usual offers fading into a slot reserved
  before their asynchronous gather starts.
- `components/SnoozeDismissMenu.tsx` — the dismissal's travel, started on the tap.
- `app/(app)/upcoming/FoldSummary.tsx` — the fold line that pulses when it catches one.
- `lib/__tests__/micro-motion.test.ts` — pins the CSS numbers to the module's, and
  enforces rules 1, 2 and 4-as-declared.

This is **tokens and a declaration, not a registry engine**: there is no scheduler
and no runtime dispatch. Adding a motion is a row in `MICRO_MOTIONS` plus a
`--motion-<name>` property and a class; the test fails either half on its own.

It fails the CSS half by CENSUS, not by pattern match: the property, class and
keyframe names are collected with a loose pattern and required to equal the
registry keys exactly. A pattern that silently skips a name it cannot spell
reports a clean count for a motion nothing checked — `[a-z]+` matched neither
`.motion-slide2` nor `.motion-count-roll`, so a 900 ms motion animating `width`
with no registry row passed every assertion (#2770). The name shape is pinned
separately, so widening the pattern is not a permanent chase.

## Not the overlay family

`lib/motion.ts` owns a different question — a panel _arriving_, at 240 ms, with an
enter/exit pair and a `usePresence` unmount window (see `docs/internals/overlays.md`).
That is navigation. Micro-motion is feedback on a write, a gesture, or a bounded
witnessed async state transition. `tick` asks "did that register?" of a drag;
`arrive` identifies content whose pending gather just resolved. Keep the vocabularies apart:
a surface that slides a sheet does not reach into this module, and the token test
fails a micro-motion name that collides with an overlay one.

## The tenants

**`settle` — `components/DoseStatusControl.tsx`, the food serving chips in
`app/(app)/nutrition/FoodLogBar.tsx`, and the quick stool type chips.** A dose check-off is the app's most tap-shaped
confirm, and the control becoming its done state is the receipt — which is why the
happy path here has never needed a toast. The food and stool chips adopt the same
receipt while food's keyed toast carries the separate Undo escape hatch. The class is hung on the
tapped control for one 300 ms run after a write lands; a refusal or dropped request
animates nothing.

The dose tenant remains narrower, and only runs when all of these hold:

- the tap was a **tap**. Server state arriving already-taken (a reload, a revalidation,
  another device) never animates; a settle claims "you just did that".
- the tap aimed at **`taken`**. Un-taking is a correction, not a confirm.
- the write **said yes**. A refusal or a dropped request wrote nothing.

It is never a gate. The state change and its resolved styling land on their own frame
(the optimistic ledger, `components/useOptimisticLedger.ts`); the animation decorates a
transition already made, and no tap ever waits on it. The carriers of "taken" are the
button's `aria-pressed`, its accessible name, its title and its colour — all correct on
the first paint after the tap, motion or no motion.

**`count` — `components/RollingNumber.tsx`, in protein quick-add, food serving rows,
and the quick stool today's count.** A quantity changing reads differently from a value being replaced, and that
difference is the information. Contract:

- the **final value is always the truth in the DOM**. It renders verbatim on the server,
  on the first client paint, and on every change. The scale pulse is only a receipt, so a
  screen reader, a no-JS reader and an exact-text assertion all read the real number.
- **`tabular-nums` is applied by the component**, not by the caller: digits that change
  width relayout the row around them, which is the one thing this motion must not do.
- it never pulses on mount and only pulses on a change.

`RollingNumber`, `data-rolling`, and the existing `rolling-count-*` test IDs are
legacy public names retained for caller and browser-test stability. “Rolling” in those
identifiers now means that the scale-pulse receipt is active; the digits do not roll or
tween, and no animation frame controls their text.

**`slide` + `fold` — the dismissal and the fold that catches it, on `/upcoming`.** One
gesture, two motions, two components, because the two ends of it are on opposite sides
of a Server Component boundary.

The lesson is the point. #2386's doctrine guarantees that quieted content stays
reachable where the user goes looking; nothing on a static page ever says so. The
dismissed row travelling downward toward the "Snoozed & dismissed" disclosure, and that
line's count answering with one ring, teaches it in the moment it is true: dismissed is
not deleted, and _here_ is where to look.

- **The travel** (`components/SnoozeDismissMenu.tsx`) starts on the tap and is never
  awaited. The class goes on the row before `runAction` awaits the write, so the
  animation rides a round-trip the dismissal was going to take anyway and the row is
  normally gone — replaced by the revalidated render — before it finishes. It is applied
  imperatively rather than through state because the row is a Server Component: there is
  no React path from the portaled menu item to the element that must move, so the menu
  walks up from its own trigger (`MenuHelpers.anchorEl`) to the row's `data-dismiss-row`
  marker. That is the only reason the escape hatch exists.
- **Only where a fold catches it.** Supplying `slideTarget` is the surface's declaration
  that it HAS a fold. `/upcoming` does; dashboard atoms do not and pass nothing, because a
  row travelling toward nowhere teaches a place that does not exist. A **snooze** does
  not travel either: it lands in the same fold, but a snooze is
  a "later" whose row is coming back on its own, and "where did it go" is a question only
  a dismiss raises.
- **The answer** (`app/(app)/upcoming/FoldSummary.tsx`) pulses when its count goes UP.
  Never on mount — a pulse on arrival is an attention claim made at someone who merely
  opened the page, which is the line a finding may not cross — and never on a **Restore**,
  which takes a row back out of the fold and is the opposite fact. The count itself is
  server truth in the summary's own text on every paint; the pulse only decorates a change.
- **No motion on the suppression bus.** This is presentation at the dismissing surface and
  nothing else: no dedupe key, no `isHiddenUnderPolicy`, no stored state changes.
- The ring is drawn as `box-shadow` rather than a real border so the line's box never
  changes size, and it is **slate, not the success green** the confirm settle uses —
  catching a dismissal is a location, not an achievement.

**`tick` — `app/(app)/timeline/TimelineScrubber.tsx`, the #2657 jump rail.** The first
tenant that is not feedback on a write. Dragging the timeline's right-edge scrubber
moves a floating bubble that names the period under the finger; the bubble beats once
each time the finger crosses out of one month and into the next, which is the difference
between scrubbing _through_ history and sliding around inside one month.

- **Its other channel is missing on most of the devices it exists for.** One 8 ms haptic
  fires alongside it (`HAPTIC_PATTERNS["scrubber-tick"]`), and iOS ships no web Vibration
  API at all — so on an iPhone the beat is the only non-textual feedback there is. That is
  why the #2657 ruling makes the visual pulse the universal channel and the haptic the
  enhancement. The iOS 17.4+ `<input type="checkbox" switch>` haptic trick is deliberately
  not used: unspecified behaviour Apple can remove, bought with a hidden form control that
  assistive technology can see.
- **The carrier is the bubble's own text**, correct on every frame with or without motion,
  and the rail's `aria-valuetext`, which announces the same period change to a reader who
  sees no bubble at all. Under reduced motion the haptic is suppressed by the same
  preference and the text is the whole feedback.
- **It fires on a crossing, never on arrival.** The bubble does not exist at rest — "no
  text at rest" is the idiom's whole point — so there is no mount to pulse on.
- The beat is replayed by **remounting the bubble's label** (React `key` on a counter),
  because a one-shot CSS animation cannot re-run from a class that never left.

**`arrive` — `components/QuickLogSheet.tsx`, the due-and-usual gather.** The sheet
reserves the context slot before it asks the server what is due and usual, so the
answer never changes panel height or moves the segment strip. When a non-empty answer
lands, its section fades once for 200 ms, opacity only. The heading and controls are
already authoritative on that frame, and a persistent `aria-live` status announces
that the options are ready. Under reduced motion they are simply present at full
opacity; no class or keyframe is scheduled. An empty or failed gather stays silent and
the reserved slot remains, so silence never reintroduces the shove.

**`disclose` (continuity) — `components/Disclosure.tsx`, every fold in the app
(#3677).** 47 files each hand-rolled a raw `<details>` and every one snapped: the panel
arrived at full height with the reader's finger still on the summary, which on a phone
is a full-screen jump. They now all render one owner, and the panel grows from the
summary downward over 200 ms on the shared curve.

- **`preserves`** — the summary you tapped stays exactly where it is while the panel
  grows below it, so the line you were reading never moves out from under you.
- **`causedBy`** — the reader's own tap, click or Enter on the summary. Nothing else
  opens a disclosure.

It is CSS on `::details-content`, not JS, and that is what makes the class safe here:
the browser owns the interpolation, the summary is interactive on the first frame, and
a fold that `lib/disclosure-memory.ts`'s pre-paint script opened before the first paint
has no earlier height to travel from — so a remembered-open panel is simply open, with
no entrance replay. That replay is exactly the ambient motion this doctrine refuses,
and it is refused structurally rather than by a guard. `components/Collapse.tsx`, the
app's button-and-panel disclosure, spends the same token on the same curve, so there is
one duration and one feel for every region that expands in place.

**The rule is asymmetric, and it has to be.** Closing transitions `content-visibility`
with `allow-discrete`, so the panel is still rendered while it shrinks. Opening does
**not**, and that is the load-bearing half: a discrete transition's value is applied at
the browser's next _rendering opportunity_ rather than when the property changes, so
listing it on the open left `details.open` true while the contents were still
`content-visibility: hidden` — `innerText` empty, and the subtree out of the
accessibility tree. Measured: 855 accessibility nodes on the click frame against 1,327
once settled. A reader who taps a fold and a test that reads one are the same case, and
neither may be told a panel is open while its contents are not there. The property has
its own guard in `e2e/disclosure-motion.spec.ts`, asserted synchronously in the same
task as the click.

**Chromium only, today.** `::details-content` and `interpolate-size` are Chromium-only
at the time of writing. Firefox and Safari drop both rules, which leaves them exactly
the instant open the app shipped before — the same end state reduced motion gets. No
browser is worse off than it was; one is better.

## How the suite proves it

`lib/__tests__/micro-motion.test.ts` owns the animation contract directly: registry ↔
stylesheet completeness, duration, allowed properties, non-looping keyframes, motion
plans, and reduced-motion suppression. The domain browser specs own the independent
carriers and user outcomes (dose state, protein total, dismissal/restore). The suite
deliberately does not count live `animationstart` events: that couples correctness to
browser scheduling while duplicating those domain flows.

## What is not here

| Deferred                                                    | Why                                                                                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A login-scoped "reduce motion" display setting beside theme | `prefers-reduced-motion` already reaches every motion here, at the OS level where most people who need it have already set it. The app-tier duplicate is a settings surface, not a motion change. |
| Settle on remaining quick-log chips and mark-done rows      | Same vocabulary, more surfaces. Food serving and the applicable stool chip/count adopted it (#3611); adopting every other chip thinly is still how a motion pass sprawls.                         |

Explicitly out of scope for this vocabulary, permanently: skeleton shimmer, attention
pulses on findings (a finding may not campaign — see the reach policy in
`docs/internals/findings.md`), chart draw-in, and page transitions.
