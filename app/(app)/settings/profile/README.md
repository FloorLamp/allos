This directory no longer serves a route.

`/settings/profile` was the old tier-first "Profile" tab; #1462 replaced it with
topic-first group pages (`/settings/health`, `/settings/training`,
`/settings/nutrition`, `/settings/coaching`, `/settings/privacy`), and per the
issue's §2 decision the old URL is NOT redirected — it 404s.

What stays here on purpose:

- `actions.ts` — the PROFILE-tier Server Actions. Action files are grouped by auth
  tier (#319) so the write-access scanner's per-file view stays uniform; moving
  them would split one uniformly-gated module across five directories for no gain.
- The form components, imported by whichever group page now renders them.
