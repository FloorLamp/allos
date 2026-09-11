# Micro-motion

Micro-motion provides feedback on an action or witnessed change, or preserves
the reader's place through an interaction. Keep it brief, bounded, and optional.
Use the [change and test policy](../change-policy.md) when extending it.

## Owners and vocabulary

[lib/micro-motion.ts](../../lib/micro-motion.ts) owns durations, the shared ease,
declarations, exemptions, and `microMotionPlan`. The Micro-motion section of
[app/globals.css](../../app/globals.css) owns matching custom properties and
classes. This is a token layer with no scheduler or runtime dispatch.

| Motion        | Duration | Purpose                                                  |
| ------------- | -------- | -------------------------------------------------------- |
| `settle`      | 300 ms   | A tapped control reaches its confirmed state.            |
| `count`       | 250 ms   | An authoritative quantity changes.                       |
| `slide`       | 300 ms   | A dismissed row travels toward its recovery fold.        |
| `tick`        | 180 ms   | Scrubbing crosses a month boundary.                      |
| `promote`     | 300 ms   | A witnessed reading moves into Now.                      |
| `arrive`      | 200 ms   | Due-and-usual offers finish gathering.                   |
| `fold`        | 500 ms   | The recovery fold's count increases.                     |
| `disclose`    | 200 ms   | An inline panel expands beneath its control.             |
| `historyfold` | 250 ms   | A History fold or rollup changes through URL navigation. |

The first seven are **information motions**. Their `MICRO_MOTIONS` declarations
state `conveys`, the fact they communicate; `carriedBy`, the text or accessible
state that communicates it without animation; and `reducedEndState`.

`disclose` and `historyfold` are **continuity motions**. Their
`CONTINUITY_MOTIONS` declarations state `preserves`, what stays continuous;
`causedBy`, the reader's action; and `reducedEndState`. `continuityMotion` rejects
missing declarations and invalid durations. Review must still judge their
meaning; field presence cannot prove that a motion helps the reader.

## Shared constraints

- Use the shared 150–300 ms band and `MICRO_MOTION_EASE`. The existing `fold`
  exemption permits exactly 500 ms for the fold's response to a dismissal; its
  longer pulse makes the destination legible. It does not extend the row's
  `slide` duration. `MICRO_MOTION_BAND_EXEMPTIONS` records the ruling and reason;
  exemptions must match the declared duration and must not remain after a motion
  returns inside the band.
- Nothing loops. Do not add ambient animation, decorative entrances, skeleton
  shimmer, attention pulses on findings, or chart draw-in.
- Controls remain usable immediately. Motion never delays a write, the next tap,
  authoritative text, or the content promised by an expanded control.
- Reduced motion shows the same information or final layout instantly. The plan
  returns zero duration, `animate: false`, and no class. CSS also neutralizes the
  animations and transitions under `prefers-reduced-motion: reduce`.
- Information animations use properties that avoid layout changes. Continuity
  may interpolate layout to preserve the reader's place. Neither may hide
  necessary state from assistive technology while announcing that it is ready.

Panel entrance and exit belong to [the overlay motion owner](../../lib/motion.ts)
and [overlay guidance](overlays.md). A History fold's same-route interaction uses
`historyfold`; this does not authorize general page transitions. Reuse existing
primitives and tokens before introducing a new motion or another preference.

## Feedback triggers

**Confirmed controls.** `DoseStatusControl` applies `settle` only after a user's
tap toward taken succeeds. Reloads, revalidation, un-taking, and failed writes
do not claim a new confirmation. Food serving and stool controls use the same
token for their successful changes. Accessible names, pressed state, and resolved
styling carry the result independently of motion.

**Quantities.** [RollingNumber](../../components/RollingNumber.tsx) renders the
final value on the server, first client paint, and every update. Its pulse marks
a change; it never interpolates the digits or plays on mount. It applies tabular
numerals itself, and a new change cancels the prior pulse. Keep the public
`RollingNumber`, `data-rolling`, and test-ID names: they identify the pulse, not a
digit animation.

**Dismissal and recovery.** `SnoozeDismissMenu` starts `slide` on dismissal without
awaiting it, and only when the host supplies a `slideTarget` leading to a recovery
fold. Snoozing does not travel. `FoldSummary` pulses when its count increases,
never on mount or Restore. The authoritative count and restorable row remain the
carriers. The fold ring uses a neutral shadow without changing box size. Motion
stays in presentation; it adds no stored suppression state or finding identity.

**Scrubbing.** `JumpRailScrubber` replays `tick` when a drag crosses a month
boundary, not on arrival. The bubble text and `aria-valuetext` always name the
period. Haptics are an enhancement; reduced motion suppresses both pulse and
haptic while preserving the text.

**Witnessed promotion.** `promote` had one tenant and one gate: `witnessedNowMotion`
allowed it only for a Now card arriving while the page stayed visible. #5435 §4
deleted both. `ControlTooltip` keeps the plan; its arrival is an interaction.

**Gathered offers.** `QuickLogMenu` owns the `arrive` plan for the quick-log
sheet's due-and-usual offers. The menu reserves panel height before gathering;
a trailing spacer absorbs unused space, while the context slot sizes to its
content. A nonempty answer fades once; its heading, controls, and persistent
live status are immediately authoritative. Empty or failed answers stay silent.

## Expanding content

[Disclosure](../../components/Disclosure.tsx) is the native `details` owner. The
caller supplies its `summary`; the component adds the shared class while keeping
native keyboard, find-in-page, and no-JavaScript behavior. CSS interpolates
`::details-content` height. A fold restored before first paint is already open,
so it has no entrance to replay. Unsupported interpolation leaves native opening
and closing available.

Opening and closing deliberately use different transitions. Closing may defer
`content-visibility` so content remains painted while shrinking. Opening must
make content available synchronously when `open` changes, and therefore does
not transition `content-visibility`. Clip the animated block axis while allowing
inline overflow, so full-width content is not cut off sideways.

[Collapse](../../components/Collapse.tsx) is the button-controlled alternative.
It uses the same `disclose` timing with a grid row transition. Content stays
mounted; the closed state uses `aria-hidden` and hidden visibility to remove its
controls from the accessibility tree and tab order. The controlling button and
panel must use the same open state.

[TimelineFilterLink](../../components/TimelineFilterLink.tsx) owns History's
`useHistoryFoldNavigate`. Fold state remains in URL parameters, with collapsed
content omitted by the server. A supported, unmodified click uses a View
Transition around the committed navigation and preserves scroll position.
Direct loads, unsupported browsers, reduced motion, and modified clicks retain
ordinary link behavior. No parallel client fold state is needed.

## Verification

The existing `lib/__tests__/micro-motion.test.ts` checks declaration/CSS
completeness, timing, permitted properties, non-looping behavior, exemptions,
and reduced-motion plans. Domain tests check the independent state and outcomes.
Use existing coverage before adding cases; counting animation events is not a
substitute for proving that state, text, and controls are correct.

For expanding content, check availability synchronously in the gesture's own
task, as `e2e/disclosure-motion.spec.ts` does. Waiting for a later frame would
miss an expanded control whose content is temporarily absent from the
accessibility tree. The [E2E guide](e2e-hygiene.md) owns browser-test mechanics.
