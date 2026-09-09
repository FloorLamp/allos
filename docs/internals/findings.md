# Findings and attention

A finding is a domain observation. Its reach, attention state, and obligation are
separate decisions. Reuse the finding builders, Upcoming suppression bus, and
shared presentation models rather than creating per-surface policy.

## Reach and identity

The care tier is eligible for Upcoming, dashboard attention, and permitted nudges.
The coaching tier describes observations on surfaces the person opens. A tier is
a ceiling: it does not guarantee a push or urgent dashboard placement. Each finding
must still earn its attention state and meet the channel/consent requirements.

`lib/rule-findings.ts` and `lib/rule-finding-prefixes.ts` own builder registration
and identity. A new engine joins the existing registry and declares its prefix,
reach, and relevant builder behavior. Dedupe keys follow stable subject/evidence
identity, not display labels. A finding about a run is keyed to that run.

Use one dashboard candidate family per finding. Rollups sort by relevance before
truncation and preserve meaningful origin links. A surface that merely hedges a
fact is not its origin. Folding is a density decision; safety and completeness
can require a full row. Upcoming due text uses the shared band-aware formatter.

## The attention doctrine

- Distinguish a proactive message from a surface the person opened. A keyboard
  edit that produces a notification is still a send for consent purposes.
- Proactive contact needs a user-owned commitment/consent or the documented safety
  basis. Observation domains must not invent obligations from missing data.
- A suggestion may decorate an already eligible message. It must not create,
  delay, or reschedule that message merely to deliver the suggestion.
- Periodic reviews use the existing chosen cadence and replace smaller reviews
  at coincident boundaries; they do not introduce a parallel contact schedule.
- Reducing contact is immediate and explained, with an offer to keep the previous
  behavior where appropriate. Confirmation must not be required to stop contact.
- Absence changes what is shown, never what is sent. After three days away a
  page may change; no catch-up message is added and no standing reminder is
  suppressed or reordered.
- Never refer to controls that a destination channel does not carry.
- Preference filters and repeat dismissal cannot override a safety floor.
- A waiting state names what the data is doing. Transport silence or unavailable
  data is not evidence about the person's behavior.

## Obligation and conservative interpretation

`must`, `should`, and `may` describe commitments and reminder reach; they do not
rename care/coaching tiers. A `may` intake item can still have safety implications.
Right-sizing suggestions reuse the shared detector and remain calm, dismissible
coaching. Compare coherent windows with enough history; do not compare a partial
period to a full-period target.

For risk totals, uncertain/on-demand exposure is counted conservatively and
labelled. For reassurance shares, exclude that exposure from the reassuring
fraction and disclose it separately. Apply obligation where the question's
direction is known, not as an upstream filter that removes the nutrient entirely.
The upper-limit and adequacy calculations in `lib/dri.ts` implement this distinction.

## Safety scope and follow-up

An empty finding set is not an affirmative all-clear. Curated datasets cover a
subset of possibilities. `lib/safety-coverage.ts` distinguishes unmatched items
from screened items with no flags, using the same identity matcher as detection.
Explain coverage quietly; do not invent another warning class.

A follow-up links a domain finding to `care_plan_items`; preserve its evidence,
resolution state, and profile scope. Domain adapters such as imaging reuse the
shared follow-up core. Care-persistent findings retain their specific persistence
contract across dismissal and resolution.

Bus-gated reminders share Upcoming's dedupe keys and suppression state. Safety
reminders use their own deduplication. An overdue safety follow-up has a per-item
off-switch under its existing consent contract, not another global setting.
See [notification suppression](notifications.md#suppression-and-safety).

## Domain boundaries

- Illness-care evaluates a cited duration/trajectory for one symptom; it is not
  symptom-combination triage. Situation-aware coaching holds inappropriate nags
  during illness and respects the post-close ease-back period.
- Condition suggestions require explicit confirmation before insertion. Reuse
  concept identity to avoid suggesting an already recorded condition.
- Reproductive-health findings remain coaching observations.
- Food/drug event findings and week-over-week variance have different reach;
  event care status does not automatically authorize a push channel.
- Paired observations use declared factors the user recorded, coverage floors,
  and the existing registry. Do not add an exploratory correlation miner or
  imply causation. Below the floor, stay silent.
- Household setup health derives structural checks at read time. It does not
  create stored finding state or a new notification engine.
- Intake suggestions are proposals, not findings. Reconsider that distinction
  only when their actual lifecycle or reach requires the finding substrate.

## Reasons and repeated dismissal

Carry structured reasons as data through the shared reason model. Builders
should not flatten the reason early and force every surface to reconstruct it.
Use profile display units and distinguish missing evidence from a neutral result.

Repeated dismissal counts distinct raisings of stable evidence. Quieting or
retiring an eligible family is a response to the user's answer, not permission
to mute safety. Changed evidence resets the response through the existing
identity rules. Dashboard and digest consume the same response; do not re-key
findings to make the state look new.

A feature claiming behavior change must state what would demonstrate benefit,
what would show it wrong, and what apparent success would be misleading. Use
existing recorded evidence; avoid adding telemetry or tests merely to restate
the claim. Safety signals retain their separately justified floor.
