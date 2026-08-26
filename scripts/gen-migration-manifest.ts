// Rewrite lib/migrations/manifest.json from the migration files on disk (#3579).
//
//   npm run gen:migration-manifest
//
// Run it when a merge conflicts on the manifest — merge order is migration order,
// so that is often. Every hash is recomputed, none is carried forward: all the
// pre-existing hashes coming back identical is what proves no shipped migration
// moved during the merge. Key order is preserved and new entries appended.
//
// It REFUSES when a shipped migration's hash changed or its file is gone, rather
// than writing over the record. Both cases are an edited shipped migration
// (lib/migrations/AGENTS.md), and rewriting the manifest to match would turn the
// violation into a clean file.
//
// The whole generator is main() in lib/migrations/manifest.ts, beside the plan and
// the hashing the immutability guard uses. This file is only the entry point, so
// that a test can execute the refusal (#3824 review).

import { main } from "../lib/migrations/manifest";

process.exit(main());
