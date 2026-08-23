#!/usr/bin/env tsx
/**
 * THE WRITER `lib/migrations/manifest.json` DID NOT HAVE (#3579).
 *
 *   npm run gen:migration-manifest                    # rewrite the manifest from disk
 *   npm run gen:migration-manifest -- --check         # verify without writing
 *   npm run gen:migration-manifest -- --allow-rehash  # rewrite a SHIPPED hash, on purpose
 *
 * The manifest holds a sha-256 per shipped migration file and exists to prove
 * nobody edited a migration after it shipped. Until now it had a reader
 * (lib/__tests__/migration-immutability.test.ts) and no writer, so every migration
 * merge conflict — and they are frequent, because merge order IS migration order —
 * ended with somebody typing a hash in by hand. A hand-entered hash is a hash
 * nobody computed.
 *
 * RUN THIS AFTER RESOLVING A MIGRATION CONFLICT, and read the summary it prints:
 *
 *   - It recomputes EVERY entry from the bytes on disk, not just the new one.
 *     That is the proof. "n unchanged" is the sentence that says no shipped
 *     migration moved during the merge; a writer that only appends cannot say it.
 *   - It keys the manifest in REGISTRY order (versions/index.ts), so appending a
 *     migration is a one-line diff instead of a re-sort.
 *   - It REFUSES a tree where index.ts and versions/ disagree. A migration in one
 *     and not the other is a conflict resolved wrong, and mid-conflict is exactly
 *     when this script runs.
 *   - It REFUSES to rewrite a hash that is already ON MAIN and exits non-zero, in
 *     both modes, unless `--allow-rehash` says to. "Already on main" is read from
 *     git — the manifest as of the merge-base with origin/main — not from the
 *     checked-in file, which `rm` used to erase along with the refusal.
 *   - Editing a migration YOUR OWN BRANCH added is not that, and says nothing.
 *
 * The flags work with `--` in front of them, as npm requires. `--check` also
 * works without it (npm hides it in the environment, where this reads it);
 * `--allow-rehash` deliberately does not.
 *
 * The hash, the file set, the ordering and the refusals all live in
 * lib/migrations/manifest-source.ts, which the immutability guard imports too. This
 * script deliberately reimplements none of them: a second spelling of the algorithm
 * is a second source of truth for the one thing the guard exists to check. The body
 * here is argv, printing and an exit code — everything testable is next door.
 */
import { runManifestCli } from "../lib/migrations/manifest-source";

const result = runManifestCli({
  argv: process.argv.slice(2),
  env: process.env,
});

if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
process.exit(result.exitCode);
