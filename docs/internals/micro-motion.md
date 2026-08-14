# Micro-motion: the small moves that carry information

The app is almost entirely static, and that is the calm identity working — no
garnish, nothing looping, nothing moving without a gesture. The exception this
document governs is motion that answers **"did that work?"** inside the interface
itself, which is faster and quieter than a toast. Motion here is information, and
it is held to the same standard as copy.

Five motions ship today (#2654, #2657). `slide` and `fold` are the two halves of one
gesture — a dismissal travelling, and the fold answering — and they are deliberately
**two** tokens, because they are two durations with two different justifications.

| Motion   | Token             | Duration             | What it says                                               |
| -------- | ----------------- | -------------------- | ---------------------------------------------------------- |
| `settle` | `--motion-settle` | 300 ms               | the control you tapped **became** its done state           |
| `count`  | `--motion-count`  | 250 ms               | a **quantity** changed, rather than a value being replaced |
| `slide`  | `--motion-slide`  | 300 ms               | the finding you dismissed **went somewhere**               |
| `tick`   | `--motion-tick`   | 180 ms               | the scrub crossed **into a different month**               |
| `fold`   | `--motion-fold`   | 500 ms (band-exempt) | the fold **caught** it — this is where to look             |

One ease curve for all five, `--motion-ease`, decelerating: the move arrives and
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
   Micro-motion section, and `e2e/micro-motion.spec.ts` counts `animationiteration`
   events at zero on the live page.
3. **Reduced motion is the designed state, not a degradation.** Every motion
   declares its `reducedEndState`: the same information, arriving instantly. A motion
   whose meaning is lost when it is switched off was decoration and does not belong
   in the table.
4. **Motion is never the only carrier.** Every motion declares `carriedBy` — the
   text, attribute or colour that states the same fact for a reader who sees no
   motion at all, including a screen-reader user and a printed page.

Rules 3 and 4 are why the declaration table exists. They are prose, so the test can
only check that the prose is there; what it prevents is a motion being added without
anyone having to answer either question.

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
  declaration table, `microMotionPlan(kind, reduceMotion)` (which folds the preference
  into a duration and a class name, returning `0` and `""` under the preference), and
  `countRollValue()`, the roll's eased curve.
- `app/globals.css`, `SECTION: Micro-motion` — the custom properties and the two
  `.motion-*` classes, plus a `prefers-reduced-motion: reduce` block that neutralizes
  them. Belt and braces: the planner already returns no class, but a stylesheet that
  only works because its JS caller remembered to check is one refactor from animating
  someone who asked it not to.
- `components/RollingNumber.tsx` — the one `requestAnimationFrame` case.
- `app/(app)/timeline/TimelineScrubber.tsx` — the jump rail's bubble, beating once per
  month boundary a drag crosses.
- `components/SnoozeDismissMenu.tsx` — the dismissal's travel, started on the tap.
- `app/(app)/upcoming/FoldSummary.tsx` — the fold line that pulses when it catches one.
- `lib/__tests__/micro-motion.test.ts` — pins the CSS numbers to the module's, and
  enforces rules 1, 2 and 4-as-declared.

This is **tokens and a declaration, not a registry engine**: there is no scheduler
and no runtime dispatch. Adding a motion is a row in `MICRO_MOTIONS` plus a
`--motion-<name>` property and a class; the test fails either half on its own.

## Not the overlay family

`lib/motion.ts` owns a different question — a panel _arriving_, at 240 ms, with an
enter/exit pair and a `usePresence` unmount window (see `docs/internals/overlays.md`).
That is navigation. Micro-motion is feedback on a write — and, since `tick`, on a
GESTURE, which is the same question ("did that register?") asked of a drag instead of a
save. Keep the vocabularies apart:
a surface that slides a sheet does not reach into this module, and the token test
fails a micro-motion name that collides with an overlay one.

## The tenants

**`settle` — `components/DoseStatusControl.tsx`.** A dose check-off is the app's most
tap-shaped confirm, and the control becoming its done state is the receipt — which is
why the happy path here has never needed a toast. The class is hung on the take button
for one 300 ms run, and only when all of these hold:

- the tap was a **tap**. Server state arriving already-taken (a reload, a revalidation,
  another device) never animates; a settle claims "you just did that".
- the tap aimed at **`taken`**. Un-taking is a correction, not a confirm.
- the write **said yes**. A refusal or a dropped request wrote nothing.

It is never a gate. The state change and its resolved styling land on their own frame
(the optimistic ledger, `components/useOptimisticLedger.ts`); the animation decorates a
transition already made, and no tap ever waits on it. The carriers of "taken" are the
button's `aria-pressed`, its accessible name, its title and its colour — all correct on
the first paint after the tap, motion or no motion.

**`count` — `components/RollingNumber.tsx`, in the protein quick-add.** A quantity
changing reads differently from a value being replaced, and that difference is the
information. Contract:

- the **final value is always the truth in the DOM**. It renders verbatim on the server,
  on the first client paint, and on every mount. The roll plays only on a **change**, so a
  screen reader, a no-JS reader and an exact-text assertion all read the real number.
- **`tabular-nums` is applied by the component**, not by the caller: digits that change
  width relayout the row around them, which is the one thing this motion must not do.
- it is **not** `components/CountUpNumber.tsx`, the other tenancy — a dashboard hero
  number ticking up once on _mount_ and explicitly never replaying. This one never plays
  on mount and only plays on a change.

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
  that it HAS a fold. `/upcoming` does; the dashboard "Needs attention" hero does not and
  passes nothing, because a row travelling toward nowhere teaches a place that does not
  exist. A **snooze** does not travel either: it lands in the same fold, but a snooze is
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

## How the browser suite proves it

`e2e/micro-motion.spec.ts` never measures a duration — the frozen-clock harness dislikes
animation timing, and "the thing was mid-animation when I looked" is the flakiest
assertion in the suite. It installs a document-level `animationstart` /
`animationiteration` probe **before** the gesture, then asserts stable post-conditions:
the keyframe ran exactly once, it never iterated, and the end state is correct. The
reduced-motion half runs the same gestures under `reducedMotion: "reduce"` and asserts
the same end states with the keyframe count at zero.

## What is not here

| Deferred                                                    | Why                                                                                                                                                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A login-scoped "reduce motion" display setting beside theme | `prefers-reduced-motion` already reaches every motion here, at the OS level where most people who need it have already set it. The app-tier duplicate is a settings surface, not a motion change. |
| Settle on quick-log chips and mark-done rows                | Same vocabulary, more surfaces. Adopting one is a class and a plan call; adopting all of them thinly is how a motion pass sprawls.                                                                |

Explicitly out of scope for this vocabulary, permanently: skeleton shimmer, attention
pulses on findings (a finding may not campaign — see the reach policy in
`docs/internals/findings.md`), chart draw-in, and page transitions.
