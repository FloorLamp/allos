# Change detection

Change detection is a family of five different questions. They stay separate
because their inputs are different; the registry describes ownership and coverage
but does not dispatch any detector. The authoritative code registry is
`lib/change-detection.ts`.

| Kind                           | Owner module                          | Rule                                                                                | Surfaces                                                  |
| ------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Series magnitude               | `lib/trends-digest.ts`                | Robust endpoints plus a per-series materiality threshold, then the shared news gate | Trends digest and tile badges                             |
| Versus baseline                | `lib/sleep-summary.ts`                | Last night against the trailing 30-night mean                                       | Dashboard sleep row, morning digest, wear reminder, recap |
| Streak / lapse                 | `lib/intake-deltas.ts`                | A taken streak broke or resumed                                                     | Telegram digest, recap, dashboard recap, household        |
| Categorical verdict transition | `lib/dashboard-reading-promotions.ts` | One of the declared stored-verdict transitions                                      | Dashboard Now                                             |
| Pipeline silence               | `lib/domain-dormancy.ts`              | A window-bounded domain stopped arriving                                            | Dashboard dormancy rows                                   |

The existing `LOGGABLE_DOMAINS` axis is censused by
`CHANGE_DETECTION_DOMAIN_CENSUS`. Every logging domain must name its detector kind,
owner module, and surfaces, or carry a non-empty argued absence. TypeScript makes a
missing row a compile error; the source guard checks that named owners and arguments
remain real.

## Digest-only series

Nutrition and general logging cadence are digest candidates, not trend metrics.
They do not join `TREND_METRIC_SLUGS`, create cards, or acquire detail pages.

- Protein uses the Nutrition chart's tracked-plus-manual daily series and a 20%
  materiality floor.
- Food-group servings use the Nutrition matrix's per-day values and a 50% floor,
  appropriate to small integer servings.
- Food logging, confirmed-dose logging, and weighing use completed-week distinct
  logged-day counts and a 34% floor, matching the practice-cadence scale.

All candidates still have to pass the shared news-grade admission gate in
`lib/trends-digest.ts`. Cadence copy reports only the measured fact; it does not
recommend more or less logging.
