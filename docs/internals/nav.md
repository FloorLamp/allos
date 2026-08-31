# Navigation doctrine

Status: shipped

What the app's chrome is, on each viewport, and which ruling decided each part.
Written because these rules lived across six issue bodies and the next person to
touch nav had no single place to read them (#3343, owner 2026-08-29; scope
addition on #4102).

Every rule here cites the ruling that made it. A rule with no citation is not a
rule yet — it is somebody's preference, and it should be escalated rather than
followed.

## The phone has one chrome, and it is the dock

**The dock is the phone's only shell chrome** (#2746 deferred this question;
#4102 answered it, owner 2026-08-29). There is no top bar. Content starts at the
top of the viewport, and the chrome budget above the first record is spent by the
page rather than by the shell — a tab-first page mounts its own sticky strip, and
`components/ShellChrome.tsx` contributes zero height on a page that registers
none.

**The set is four slots plus a raised centre puck: Home · Training/History ·
[puck] · Search · More** (#2651 fixed the count and the shape, owner 2026-08-13;
#4102 moved one occupant, owner 2026-08-29). Four, always: a fifth would put a
destination under the raised control and a third would leave the row visibly
unbalanced. The registry is `lib/mobile-dock.ts`.

- The second slot is `trainingRelevant ? TRAINING : HISTORY` (#3343 Q5, owner
  2026-08-29). History is Timeline's literal successor — it absorbed that
  route's content and serves the audience the slot existed for. Upcoming and
  Nutrition were both considered and rejected there; do not revisit either.
- The third slot is **Search**, which took Trends' (#4102, owner 2026-08-29:
  _"i realize i don't actually use trends that much"_). Lookup beats browse when
  the palette indexes 24 domains plus a ~30-page registry; Trends' glance job is
  done by the dashboard's Standing zone, and Trends stays one tap away in the
  drawer.
- **Search and More are triggers, not destinations.** Neither ever carries
  `aria-current` — the surface a control opens is never "the page".

**Nothing on the dock ever campaigns for attention** (#2651, owner 2026-08-13).
No badge, no count, no dot, on any slot or on the puck. Permanently-visible
chrome is the worst possible place to raise attention: it is on screen for every
second of every page, so anything it displays is displayed forever. This is a
rule about the BAR, not about which destinations happen to sit in it, so it binds
each new slot on arrival.

## Groups fold on the desktop and expand on the phone

**The desktop sidebar collapses a nav group behind a disclosure; the phone drawer
renders every group's rows inline, under a header that is a plain label rather
than a button** (#3343 Q4, owner 2026-08-22; scope ratified uniform 2026-08-29).

The fold spends a TAP to buy back VERTICAL ROOM. That is the right trade in a
sidebar where the 2026-08-19 census found real destinations pushed below the
fold. On a phone the scale is reversed — the drawer scrolls freely and a tap is
the expensive thing — so the same mechanism would be trading a cheap resource for
a dear one. One boolean carries it (`inDrawer`, in `components/SidebarContent.tsx`
and `components/Nav.tsx`); a per-group flag was rejected as the parallel-variant
shape the standing constraint rules out.

**The header keeps its grouping when it loses its button.** A control that
toggles nothing is exactly the tap this ruling exists to stop spending, and a
chevron would announce a fold that is not there — but dropping the _structure_
would have cost screen-reader users the grouping the ruling names, so the drawer's
group container carries `role="group"` and `aria-labelledby` instead.

**A longer drawer is a measured thing, not an assumed one.** Expanding every
group grew the drawer's nav from ~9 rows to ~21, and the lane that landed it
recorded that nothing in the repo would have noticed if that made the drawer
unusable, _because Playwright's visibility check is not viewport-bounded_.
`e2e/nav-consolidation.spec.ts` closes that: at 390×844 with every group
expanded, the panel is asserted inside the viewport and the footer asserted
reachable by scroll. When you change what the drawer holds, that is the guard to
re-derive — `toBeVisible()` will not tell you.

## The nav is deterministic

**No frecency, no pinning, no chrome that reorders itself** (#1042; #3154 move 3
superseded by #4102, owner 2026-08-29). The Frequent shortcut row and its
`localStorage` visit tally are deleted, not disabled. It duplicated the dock for
the daily set and Search for lookups, and it was the nav's only non-deterministic
element: a system that quietly changes is indistinguishable from a bug, and that
argument applies to chrome at least as hard as to a dashboard.

What survives in `lib/recent-pages.ts` is the route→name registry, which answers
a different question — _what is this route called_ — and is load-bearing for the
dashboard's doors.

**Position is earned by frequency, but the ordering is fixed when it is set**
(#1042), and re-ranking is an owner call recorded on an issue, never a runtime
behaviour.

## Chronology's affordance lives where chronology lives

**The month calendar belongs on the record, not in the nav** (#4102, owner
2026-08-29, superseding #3154's sidebar Calendar row and #3452's drawer band).
A day grid is a way of reading a history; the chrome is a way of reaching a page.
Putting the grid in the chrome spent permanent vertical room on every screen to
serve one page's question.

The move **completed in #4280**, as one change: `/history` grows the mount and
the sidebar and drawer drop theirs in the same commit, because either half alone
is worse than neither — removing the mounts first strands the grid with no home,
and adding the page mount first renders it twice.

`components/EventCalendar.tsx` opens from the record's own filter row, through
the shared `AnchoredPanel` fork (popover from `md` up, bottom sheet below), so
the page spends no vertical chrome on it — /history's ~140px budget above its
first record measured 134px before the move and is unchanged by it. Two things
follow the calendar out of the nav: `getTimelineDates` is read by `/history`
alone instead of by the app shell on every page, and the drawer's width floor
drops its `--week-grid-min` term (#4102's anti-drop census, owner 2026-08-29:
"20rem preferred stands alone") — measured at 320px both before and after,
because the term only ever won on a device with a left safe-area inset.

## There is one profile switcher

**One identity bar, one switcher panel, one selection vocabulary** (#1801;
narrowed by #4102, owner 2026-08-29). The bar answers "whose data is this, and who
am I acting as?" and opens the panel in place.

- **Identity chrome or brand chrome, never both.** A multi-profile instance shows
  the identity bar in the wordmark's slot; a single-profile instance shows the
  wordmark, because identity is unambiguous there and the brand line is the
  honest occupant.
- **It rides the top of the sidebar and the top of the drawer.** The drawer used
  to be the exception, because on a phone the acting profile was readable in the
  top bar without opening anything. That bar retired, so the exception went with
  its reason.
- **The phone's top-drawer switcher is retired** (#4102). There is no
  second, phone-shaped selection surface; the drawer takes the sidebar's panel.

## Where the rules live in the tree

| Rule                                              | Code                            |
| ------------------------------------------------- | ------------------------------- |
| The dock's slots and the active-slot predicate    | `lib/mobile-dock.ts`            |
| The dock's markup and its two triggers            | `components/MobileDock.tsx`     |
| The drawer, its gestures and its modal semantics  | `components/MobileNav.tsx`      |
| The shared sidebar/drawer content, and `inDrawer` | `components/SidebarContent.tsx` |
| The nav registry, the fold, and the group's a11y  | `components/Nav.tsx`            |
| Which row is lit, on both surfaces                | `lib/nav.ts`                    |
| Which rows a profile is eligible for              | `lib/nav-relevance.ts`          |
| The route→name registry                           | `lib/recent-pages.ts`           |
| The sticky host for a page-owned strip            | `components/ShellChrome.tsx`    |

## Related

- `docs/internals/nav-pending.md` — why a nav tap must show something, and why a
  second tap must do nothing.
- `docs/internals/overlays.md` — the drawer's presentation exception, and the
  a11y floor it still owes.
- `docs/internals/design-doctrine.md` — the house rules this document applies to
  one surface.
