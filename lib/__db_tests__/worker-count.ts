import { availableParallelism } from "node:os";

/**
 * DB specs mix synchronous SQLite work with a large shared module graph.
 *
 * Vitest normally uses one fewer worker than the available CPU count. Preserve that
 * behavior on constrained hosts, including CI, but cap wide machines at 12 so they do
 * not multiply the graph across every logical CPU. Measured for issue #3520: 12
 * workers beat the default pool on 16 CPUs (50.1s vs 59.4s).
 */
export function dbWorkerCount(parallelism = availableParallelism()): number {
  return Math.max(1, Math.min(12, parallelism - 1));
}
