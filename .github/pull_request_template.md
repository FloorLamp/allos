## Summary

<!-- what changed and why -->

## Checklist

- [ ] No PHI in code, fixtures, seed, or this description (synthetic/obfuscated only)
- [ ] Profile-scoped SQL filters by `profile_id`; new owned tables added to `lib/owned-tables.ts`
- [ ] Schema change ships as a NEW append-only migration in `lib/migrations/versions/` (+ `index.ts` + `manifest.json` hash); no shipped migration edited
- [ ] Gates green: `format:check` · `lint` · `typecheck` · `test` · `test:db` · `build`
- [ ] Seed updated if a new domain landed
- [ ] README updated if user-visible (nav/route/Settings tab/integration/env var) behavior changed
