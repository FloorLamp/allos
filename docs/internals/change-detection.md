# Change detection

Change detection is a family of five different questions. They stay separate
because their inputs are different; the registry describes ownership and coverage
but does not dispatch any detector. The authoritative code registry is
`lib/change-detection.ts`.

| Kind                           | Owner module                          | Rule                                                                                     | Surfaces                                                   |
| ------------------------------ | ------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Series magnitude               | `lib/trends-digest.ts`                | `windowMovement` robust endpoints plus a per-series threshold, then the shared news gate | Trends digest and tile badges                              |
| Versus baseline                | `lib/movement.ts`                     | The latest reading against a trailing mean, declared basis                               | Sleep hero and row, digest, wear reminder, recap, coaching |
| Streak / lapse                 | `lib/intake-deltas.ts`                | A taken streak broke or resumed                                                          | Telegram digest, recap, dashboard recap, household         |
| Categorical verdict transition | `lib/dashboard-reading-promotions.ts` | One of the declared stored-verdict transitions                                           | Dashboard Now                                              |
| Pipeline silence               | `lib/domain-dormancy.ts`              | A window-bounded domain stopped arriving                                                 | Dashboard dormancy rows                                    |

`CHANGE_DETECTION_DOMAIN_CENSUS` censuses the `LOGGABLE_DOMAINS` axis. Every
domain names its detector kind, subdomain scope, exported owner symbol and
surfaces, or carries an argued absence. This matters for broad rows: pipeline silence covers blood pressure
and resting heart rate, not every vital; temperature has no silence detector.
Substance is an argued absence: its cap-direction targets never enter the
floor-direction progress rollup weekly-target readings are built from, and no cap
surface promotes a cross-window change. TypeScript makes a missing
row a compile error; the source guard checks each named owner symbol is still a
real export, not merely an existing file.

## Digest-only series

Nutrition and general logging cadence are digest candidates, not trend metrics.
They do not join `TREND_METRIC_SLUGS`, create cards, or acquire detail pages.

- Protein uses the Nutrition chart's tracked-plus-manual daily series and a 20%
  materiality floor.
- Food-group servings use the Nutrition matrix's per-day values and a 50% floor,
  appropriate to small integer servings.
- Food logging, confirmed-dose logging, and weighing use completed-week distinct
  logged-day counts and a 34% floor, matching the practice-cadence scale.

All candidates still pass the shared news-grade admission gate in
`lib/trends-digest.ts`. Cadence copy reports the measured fact only; it does not
recommend more or less logging.
