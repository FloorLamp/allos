## Summary

<!-- what changed and why -->

## Validation

<!-- Name the checks run and their results, including failures or skips.
Use docs/development.md to choose local checks. Required CI checks still apply.
For each new abstraction or test file, explain the gap existing code/coverage
cannot cover. Report production and test additions/deletions separately when
adding code; explain substantial growth. -->

## Checklist

- [ ] No PHI in code, fixtures, seed, or this description (synthetic/obfuscated only)
- [ ] Profile-scoped SQL filters by `profile_id`; new owned tables added to `lib/owned-tables.ts`
- [ ] Schema change ships as a NEW append-only migration in `lib/migrations/versions/` (+ `index.ts` + `manifest.json` hash via `npm run gen:migration-manifest`); no shipped migration edited
- [ ] Relevant local checks recorded above; required CI checks pass on this head
- [ ] Seed updated if a new domain landed
- [ ] Updated the existing behavior reference linked from `docs/features.md`, or the matching setup guide, if its contract changed; no appended incident narrative
