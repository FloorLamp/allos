# Supplements and medications

Supplements and medications share `intake_items`, scheduling, dose writes, safety
assessment, and supply accounting. Their pages can differ without creating a
second intake model. Start at `lib/types/intake.ts`, `lib/intake-cadence.ts`, and
`lib/queries/intake/`.

## Form and identity

Use the shared intake form with the required subject context from
`loadIntakeFormContext`. Keep its age, local day, stack, variants, and conditions
together across add and edit entry points. The entry point owns the kind; naming
and product selection do not silently change it. Present the selected facts with focused
editors and submit the complete form state so hidden editors do not drop values.
Formulation/concentration must come from an explicit product choice before an
amount can be expressed in mL. `prnDefaultsFor` offers single-ingredient label
figures only: a complete single-ingredient CUI identity matches by
`ingredientCuiKey`; without one, the name must equal a curated synonym. Listed
composition, multiple ingredient CUIs, and unresolved qualifiers such as a strength
suffix refuse the label. Unknown qualifiers stay in picked names; only exact catalog
pick names and labels can canonicalize them. Ingredient-level interaction and fever
classification still include combination products. A name, composition, or
confirmed-code change withdraws only the prior suggestion-owned dose; saved and
caregiver-edited amounts stay.
For name-only PRN label matching, a linked bottle's `supply_name` is the product
name; an unlinked item falls back to its own display name. Linking never overwrites
that display name or the person's dose amount.
`useIntakeRxcui` owns one revision across name lookup and ingredient confirmation.
A new identity operation, clear, composition edit, draft restore, reset, or unmount
retires every pending response, including a lookup for the same code. Only a current
completion can seed the form; a current offline/no-match result retains name-only
fallback. Restoring a draft restores its code and treats its dose as personal input.

Prefer confirmed ingredient/product identity where available and preserve the
distinction between confirmed identity and a name-only match. Editing identity
can change the safety assessment. Structured purposes live in
`intake_item_purposes`; do not flatten them into an unrelated free-text model.
Reuse the existing catalog picker, ranking, grouping, and formulation helpers.

## Dose ledger and schedules

A dose log is an administration record, not a daily boolean. Preserve quantity,
product given, the actual administration instant, and the recording instant.
Multiple PRN administrations on one day remain distinct. Historical corrections
must preserve the relevant occurrence and schedule meaning.

`intake_dose_schedule_versions` provides effective-dated schedule and amount history.
`doseScheduleAsOf` judges a local day using the version in force then, including the
full stored amount string and whether that amount was captured or assumed. Append a
version when schedule or amount facts change, and load history once per profile/request
or tick through the existing query path. Before captured history begins, use the oldest
known amount and state that it is assumed. Existing administration logs stay as written.

Keep calendar cadence, situation conditions, dose slots, and obligation distinct.
The pre-workout condition is about the day's situation; its send timing is a
separate question. Derived situations come from the profile's data and the shared
situation model. Pause-during-situation is an explicit inverse condition, not a
caller-specific exception.

## One write core

`lib/queries/intake/adherence.ts` owns scheduled status transitions:

- One-way `markDoseTaken` and `markDoseSkipped` stop on an existing row and report
  its actual status. Retries must not flip an already resolved dose.
- Explicit `setDoseStatusCore` may flip or clear when the user is operating the
  web control. It still honors paused-item and other lifecycle constraints.
- Server Actions authorize and validate, then render the core's typed outcome.
  Do not add a second SQL path that reports unconditional success.
- Supply adjustments follow the ledger row's own `supply_adjusted` state. Clearing
  a historical row that never consumed supply must not add supply back.
- History correction does not re-arm missed-dose escalation. Telegram time
  correction uses stored ledger state and preserves local-day attribution.

PRN limits use the trailing 24 hours, not the calendar day, and are amount-aware.
A redose notice is armed by a confirmed administration and keyed to that event;
reaching the confirmed daily maximum suppresses another notice. Use the shared
safety decisions across web, Telegram, offline replay, and household actions.

## Obligation and safety

`obligation` is one stored field:

| Value    | Ordinary reminder behavior                         |
| -------- | -------------------------------------------------- |
| `must`   | Remind and allow the defined escalation            |
| `should` | Remind                                             |
| `may`    | On-demand access, with no ordinary pushed reminder |

Medication defaults and explicit confirmation for reducing commitment follow the
existing form rules. `kind` still selects clinical identity and safety behavior;
it does not substitute for obligation. A retained slot on a `may` item is an
access hint, not authorization to push.

Safety assessment remains obligation-blind where excluding exposure would hide
risk. Upper-limit totals include relevant on-demand amounts; adequacy shares use
committed intake and disclose excluded amounts. Neither operation should make a
nutrient disappear. See [findings](findings.md#obligation-and-conservative-interpretation).

Adherence-based demotion is an offer, not an automatic change to commitment. The
unconfirmed imported-medication Stop flow is its own explicit user action. Dose
reminders and safety escalation do not inherit ordinary finding dismissal.

## Supply and the medicine cabinet

`shared_supplies` represents a shared bottle. An item's nullable `supply_id` links
to it; linking clears the private count. Keep a single quantity owner.

The existing refill and supply-pool cores own counter writes. The item form's
absolute quantity edit uses compare-and-set against its loaded snapshot; ordinary
name or schedule edits must not overwrite a concurrent dose decrement. Dose
transitions update private or pooled supply through that same accounting path.

Refills are additive: two bottles can be a legitimate restock. Keep the action
available and show recent completion rather than treating a second tap as always
invalid. Report the core's actual fill size and resulting quantity.

A pool has one projection and one refill alert. Pool visibility and edits must
resolve current access at the request boundary using the existing authorized
profile set. Do not manufacture grants or expose unrelated members' data through
a shared bottle. Product-fact exchange reuses the pool/item model rather than
copying independent inventories. The cabinet is reached from its consumers.

Adding a bottle for a second person copies ONE named member's row; it never
switches the caller's active profile and never opens the add form. The copy takes
the product, the source member's obligation and their schedule, and nothing else:
the amount is derived for the recipient (the pediatric weight band from their own
weight where the product has one, else the label's adult dose, else no dose rows
at all), and there is no start date, weight, history or stock. With several
readable members the source is chosen explicitly; with one it is named. Source,
membership, duplicate eligibility and the dose basis are re-read inside the write,
which refuses a stale offer rather than copying a different member's plan.

Eligibility asks the canonical models, not private ones. Allergy is a gate and
uses the drug-allergy cross-check about the row the copy would create, so the
offer and the row's own warning are one judgment. Product identity is RxNorm
first, taken across the whole membership so every reader derives the same
product; an item's dose amount is per-dose and is never read as a strength.

## Amount parsing and suggestions

An ambiguous dose string remains unreadable; do not guess its locale or unit.
Use the shared grouped-number/dose parser and its curated separator cases. A
leading zero or explicit formulation may resolve an otherwise ambiguous shape;
a new separator must preserve name/amount boundaries. Surface unknown amounts
honestly in safety coverage. `npm run census:dose-amounts` measures stored input;
source literals alone cannot describe the population.

Curated biomarker-to-supplement suggestions use the bundled map and existing
safety screens. The AI path is a labelled fallback for uncovered cases. Both use
the shared suggestion query and existing review UI; neither silently inserts an
intake item or bypasses interaction screening.

For a change, use existing schedule, dose-lifecycle, PRN, and supply tests in the
unit/DB tiers. Browser tests are warranted only for a distinct interaction risk.
Apply [the shared test policy](../change-policy.md).
