import { availableParallelism } from "node:os";

/**
 * DB specs mix synchronous SQLite work with a large shared module graph.
 *
 * One worker per logical CPU overpays the graph on wide machines, while a small amount
 * of oversubscription keeps constrained machines busy around setup and SQLite waits.
 * Measured for issue #3520: 12 workers beat 16 on 16 CPUs (50.1s vs 59.4s), and 6 beat
 * 4 on a four-CPU constraint (59.5s vs 70.2s). Cap the graph copies, but scale down on
 * smaller hosts instead of imposing a workstation-sized pool everywhere.
 */
export function dbWorkerCount(parallelism = availableParallelism()): number {
  return Math.min(12, Math.ceil(Math.max(1, parallelism) * 1.5));
}
