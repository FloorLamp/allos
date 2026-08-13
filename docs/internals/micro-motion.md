# Micro-motion: the small moves that carry information

The app is almost entirely static, and that is the calm identity working — no
garnish, nothing looping, nothing moving without a gesture. The exception this
document governs is motion that answers **"did that work?"** inside the interface
itself, which is faster and quieter than a toast. Motion here is information, and
it is held to the same standard as copy.

Two motions ship today (#2654). A third — a dismissed finding travelling toward the
fold that catches it — is described by that issue and deliberately not built yet;
see [What is not here](#what-is-not-here).

| Motion   | Token             | Duration | What it says                                               |
| -------- | ----------------- | -------- | ---------------------------------------------------------- |
| `settle` | `--motion-settle` | 300 ms   | the control you tapped **became** its done state           |
| `count`  | `--motion-count`  | 250 ms   | a **quantity** changed, rather than a value being replaced |

One ease curve for both, `--motion-ease`, decelerating: the move arrives and
settles, it never bounces back.

## The four rules

1. **150–300 ms.** Long enough to be read as a transition, short enough that a
   returning glance never waits on it. `MICRO_MOTION_MIN_MS`/`MAX_MS` are the band
   and `lib/__tests__/micro-motion.test.ts` fails a duration outside it.
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
- `lib/__tests__/micro-motion.test.ts` — pins the CSS numbers to the module's, and
  enforces rules 1, 2 and 4-as-declared.

This is **tokens and a declaration, not a registry engine**: there is no scheduler
and no runtime dispatch. Adding a motion is a row in `MICRO_MOTIONS` plus a
`--motion-<name>` property and a class; the test fails either half on its own.

## Not the overlay family

`lib/motion.ts` owns a different question — a panel _arriving_, at 240 ms, with an
enter/exit pair and a `usePresence` unmount window (see `docs/internals/overlays.md`).
That is navigation. Micro-motion is feedback on a write. Keep the vocabularies apart:
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

## How the browser suite proves it

`e2e/micro-motion.spec.ts` never measures a duration — the frozen-clock harness dislikes
animation timing, and "the thing was mid-animation when I looked" is the flakiest
assertion in the suite. It installs a document-level `animationstart` /
`animationiteration` probe **before** the gesture, then asserts stable post-conditions:
the keyframe ran exactly once, it never iterated, and the end state is correct. The
reduced-motion half runs the same gestures under `reducedMotion: "reduce"` and asserts
the same end states with the keyframe count at zero.

## What is not here

| Deferred                                                    | Why                                                                                                                                                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `slide` — a dismissed finding travelling toward its fold    | It needs a fold that reliably exists on the dismissing surface and a FLIP-style measurement across many finding surfaces. A token with no tenant is dead vocabulary the next reader has to disprove, so it lands with its surface. |
| A login-scoped "reduce motion" display setting beside theme | `prefers-reduced-motion` already reaches every motion here, at the OS level where most people who need it have already set it. The app-tier duplicate is a settings surface, not a motion change.                                  |
| Settle on quick-log chips and mark-done rows                | Same vocabulary, more surfaces. Adopting one is a class and a plan call; adopting all of them thinly is how a motion pass sprawls.                                                                                                 |

Explicitly out of scope for this vocabulary, permanently: skeleton shimmer, attention
pulses on findings (a finding may not campaign — see the reach policy in
`docs/internals/findings.md`), chart draw-in, and page transitions.
