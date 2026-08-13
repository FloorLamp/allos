Three ways the browser suite asserted less than it appeared to. All three were filed from real CI failures, so the success criterion here is "it asserts what it claims", not "it is green".

Closes #2631
Closes #2632
Closes #2648

## #2631 — a name-based `.first()` that also resolves on the DESTINATION page

`visit-links.spec.ts:77` handed `followLink` a bare `getByRole("link", { name: /sinus infection/i }).first()`. `followLink` **re-evaluates its locator on every retry**, so a locator that is only a name is evaluated against whatever page is loaded at that moment.

The destination carries a match. `illnessCareTimelineEvents` (`lib/illness-timeline-view.ts`) renders each in-range encounter as a timeline care event whose link TEXT is the encounter's `reason` — the VISITLINKS seed sets that to `"Sinus infection"` (`e2e/seed/medical.ts`) — pointing at `encounterHref(id)`. So under contention: click lands, transition has not committed, retry fires, the locator resolves on the cockpit, and the test ends up at `/encounters/9077`.

Pinned to `data-testid="episode-index-row"`, which exists only on the index. The `first-ok` note now argues the axis that matters — how many elements match **on the page being clicked** — instead of which profile owns the fixture, which is true and answers a question no `.first()` asks. The two sibling notes in the same file were reworded on the same axis.

### The sweep

Every `followLink` call site whose locator is name- or text-derived rather than pinned to a testid (117 of 367 total; 9 page-rooted with a regex name, plus the container-scoped set). For each, checked whether the destination page renders a LINK matching that name and pointing somewhere else:

| site | destination | verdict |
| --- | --- | --- |
| `visit-links.spec.ts:77` `/sinus infection/i` | episode cockpit | **the live bug** — timeline encounter link → `/encounters/<id>` |
| `visit-links.spec.ts:32` `/Office Visit/` | encounter detail | safe — the type is a heading, never a link |
| `visit-links.spec.ts:64` `/Amoxicillin \(e2e\)/` | medication detail | safe — the name is a heading; the only links are "Back to medications" and the prescribed-at encounter |
| `create-visit-from-record.spec.ts:53` `/Eye exam/` | encounter detail | safe — same shape |
| `encounter-enrichment.spec.ts:35` `/Office Visit/` | encounter detail | safe — same shape |
| `protocol-reach.spec.ts:40,212` `/Creatine…/`, `/Red light/` | protocol detail | safe — `PracticeCardHeader` renders the name as `<h2>`; the seeded red-light protocol has no gear row |
| `dashboard.spec.ts:274` `"Reach 74 kg"` | `/training?tab=goals` | safe — the goals tab renders no link for a goal name |
| `results-page.spec.ts:48`, `review-inbox.spec.ts:403`, `training-first-run.spec.ts:118` | same-page / nav | safe — the destination's match is the SAME href, so a re-click is idempotent |
| `illness-episode-followups.spec.ts:563`, `import-produced-panels.spec.ts:82`, `workout-history.spec.ts:159`, `equipment-registry.spec.ts:38`, `immunization-titer-link.spec.ts:27` | various | safe — already pinned to an index-only testid container |

One refinement worth recording: `.first()` is what makes this shape SILENT. Without it, a destination-page match either violates strict mode (loud) or is the single match (still wrong, but rarer). A name-based `.first()` handed to `followLink` is the combination to look for.

## #2632 — the overflow item that never rendered (not one that was covered)

Established which of the two it was before touching anything, as the issue asked. The CI call log is the evidence:

```
Error: locator.click: Test timeout of 30000ms exceeded.
Call log:
  - waiting for getByTestId('wellness-practice-edit')
```

That is the ONLY call-log line. Playwright prints `locator resolved to <button …>` followed by actionability lines the moment an element is found, and `intercepts pointer events` when one is covered. Neither appears — **the locator never resolved**. `wellness-practice-edit` is a `role="menuitem"` inside `OverflowMenu`'s portal, which is mounted only while `open`, so "never resolved" means the menu never opened.

So this is **not** the `menu-confirm-cancel` backdrop bug and **not** a product bug. Two supporting points: line 219 is that test's FIRST and only menu interaction (the issue's "second interaction, after an earlier menu" reading does not hold — each `test({ page })` gets a fresh page anyway), and AQ's `button` → `menuitem` role change is not in play here because the spec targets by testid.

It is the #500/#830 pre-hydration swallow on a menu toggle — the case `hydratedClick` exists for and that every other overflow-menu spec in this suite already uses (`trends-body-edit`, `biomarker-panels`, `menu-confirm-cancel`, `sleep-page`). `choosePracticeAction` used a raw `.click()`.

Fixed in the spec, product untouched: one `openRowMenu` helper that drives the trigger with `hydratedClick` (a retry loop is unavailable — a second tap closes what the first opened) and then awaits the menu's OPEN state before clicking the item. Waiting on the ITEM was also what made the failure unreadable: it cannot distinguish "the menu never opened" from "the item is slow", and both render as one 30s wait with no actionability lines.

## #2648 — three `process.env.CI` sites, decided one at a time

`security-headers.spec.ts:151` was already gone: #2645 (8f119e66) removed it along with the fourth. The issue's table is stale on that row.

| site | gated | verdict |
| --- | --- | --- |
| `illness-episode.spec.ts:87` | a loosened `/no-store\|no-cache/` alternative | **production-ness → same defect.** A cache header is a property of the RESPONSE. Assert `no-store` unconditionally. |
| `emergency-card.spec.ts:132` | the whole genuine-offline block | **production-ness → same defect.** The comment's premise ("only the CI harness boots a production build with a live service worker; local `next dev` unregisters it") died with #1538: `fixtures.ts:303` spawns every worker with `NODE_ENV: "production"`, and `ServiceWorkerRegister` only unregisters when `NODE_ENV !== "production"`. Un-gated. |
| `global-setup.ts:113` | whether to run `npm run build` | **genuinely runner-only.** Who owns the build step IS a fact about the runner; the app both paths serve is identical. Kept, marked `ci-ok`. |

The emergency-card one was the costly gate: the single most important assertion in that spec — the card is readable with **no network** — ran nowhere but CI. It passes locally now, 3× at retries=0, which is the direct proof the gate was standing in for nothing.

### The ratchet

Worth adding, per the issue's "decide after, not before": two for two, the spec sites were the same category error, and after the fix there is not one legitimate `process.env.CI` branch left in a spec. That is a rule, so it is enforced — a new branch in any `e2e/*.ts` fails `lib/__tests__/e2e-hygiene.test.ts` unless it carries a `ci-ok: <why>` naming the runner-only fact. No per-file allowlist: the honest answer is a written reason or a deleted branch.

Two deliberate details. Prose that merely NAMES the variable — a comment recording why a branch was removed, which the two fixed specs now carry — is not a branch and is not counted. And unlike `first-ok`/`topass-ok`, the marker is accepted on the branch line or either line touching it: `if (process.env.CI) {` is too short to hold a reason worth reading, and a reason crammed onto it becomes a rubber stamp. Verified the ratchet fires by planting a branch (it did) and removing it.

## Verification

- `e2e/visit-links.spec.ts`, `e2e/wellness-practices.spec.ts`, `e2e/illness-episode.spec.ts`, `e2e/emergency-card.spec.ts` at CI parity, `--repeat-each=3 --retries=0`: **48 passed (9.2m)**.
- No shared e2e helper or product file changed, so there are no downstream consumers to re-run; `openRowMenu` is local to `wellness-practices.spec.ts`.
- `docs/internals/e2e-hygiene.md` gains the three rules: the `.first()` page-axis, opening a menu vs. waiting on its item (including how to read the call log for render-vs-covered), and the runner-is-not-the-app section.
