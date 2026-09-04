# Global search: what it indexes and how it ranks

Status: shipped

One fan-out (`searchAll`, `lib/queries/search.ts`) runs a small capped `LIKE`
query per domain for the **acting profile**, hands the flat hit list to the pure
ranker (`lib/search-rank.ts`), and the palette renders the groups in one fixed
order. This document covers the part that is not obvious from the code: which
kinds are indexed as **entities**, which as **rows**, and why they rank
differently.

## Two kinds of hit

**An entity has a page, so the hit lands on it.** Clinical results, imaging,
documents, medications, providers, episodes, protocols, practices, equipment —
the href is the most precise destination the row supports (#1568).

**A logged row has no page, so the hit lands on the record's day view, scrolled
to the row.** Seven of the record's Logs kinds are row-only (#5006): **doses ·
food servings · practice sessions · symptoms · mood check-ins · body readings ·
sleep nights**. `/history?day=<day>&kind=<kind>` is that address (#3958), and the
row already carries `id={timelineEntryAnchorId(row.id)}`, so the fragment lands
on the entry itself. No new route, no new page.

## The logged group

`lib/queries/search-logged.ts` holds all seven. Each declares only what differs —
its kind, the noun its subtitle names, and the read that finds it — and one
mapping builds the hit, so an eighth kind is a table row rather than an eighth
copy.

| Kind | Vocabulary the query matches | Entry id the anchor is built from |
| --- | --- | --- |
| `dose` | item name, amount taken | `dose:<log id>` |
| `food` | food group's name (and its stored key) | `food:<event id>` |
| `practice` | practice name | `practice:<session id>` |
| `symptom` | symptom label (and its stored key) | `symptom:<day>:<symptom>` |
| `mood` | "mood"/"check-in", and the day | `mood:<row id>` |
| `body` | measure label, and the value AS STORED | `body:<column>:<row id>` |
| `sleep` | "sleep", and the wake day | `sleep:<wake day>` |

Four rules hold across all seven:

- **Five, newest first.** Every statement is `ORDER BY date DESC LIMIT 5`, and
  the result is capped again after any in-memory fan-out (a `body_metrics` row
  carries up to three measures), so the group costs a bounded seven reads.
- **Acting profile only**, filtered `profile_id = ?` in the statement text — the
  dose ledger through its parent `intake_items`, which is where a dose log's
  owner lives. The day view these open is acting-profile-only by ruling.
- **The day is a profile-local day**, never a sliced UTC instant. Sleep is the
  one that has to compute it: the night is filed under the local day of the wake
  instant (`zonedDateParts(tz, ended_at)`), the same anchor `lib/history.ts` uses;
  `metric_samples.date` is the source's own stamp and can sit a day off it.
- **The entry id is the record's own**, and the anchor is built by the same
  `timelineEntryAnchorId` the row's `id=` is built with. A drifted spelling is a
  link that scrolls nowhere, so `lib/__db_tests__/search-logged-kinds.test.ts`
  resolves every href against the gather's rendered rows rather than a re-typed
  string.

**Body readings print no value.** Canonical storage is kilograms and the
conversion to the login's unit belongs to the render boundary, so the hit's title
is the measure label alone. The stored number is still matchable — typing `70.4`
finds the reading — and the row itself states it in the reader's own unit.

## Ranking

Within a domain the ranker sorts by match quality (exact > prefix > substring),
then recency, then title. **The logged domains invert the first two keys**: an
entity is asked for by name, a logged row by recency — "my latest sauna" — and
tier-first put a year-old `Sauna` above this morning's `Sauna, infrared`. A
same-day tie still falls back to match quality.

Across groups the fixed `SEARCH_DOMAIN_ORDER` stands. The logged domains sit with
`activity` (the other "things that happened") and above the catalog entities that
name what they were logged against. `page` is last, always, so the kind's static
list entry ("Food history", "Dose history") sits below the entries it would have
shown — a query matching both gets the entries first, newest first, the list
entry last.
