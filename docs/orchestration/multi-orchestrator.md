# Orchestrators on one repo

Sessions share GitHub issues, branches, PRs, and `main`. Their local rosters and
ledgers do not establish what another session is doing. Follow
[dispatch](dispatch.md) for capacity and candidate rules,
[lifecycle](lifecycle.md) for scope, and the
[change and test policy](../change-policy.md) for bounded work.

## The slice

The PM assigns domain and file slices in the pinned Ladder issue. Dispatch only
inside the assigned slice, including its explicit file exclusions. Resolve a
needed cross-slice edit with the owning session and PM before proceeding. Use the
session's authorized communication channels; tool availability alone is not
permission to message another session.

## Slots

Count running implementation and review agents against the applicable limits.
A banked branch holds no running-agent slot; preserve its worktree and resume from
the banked head when ready. Prioritize required review when it is blocking landing,
freeing capacity if necessary. Sessions sharing a machine also share its resource
constraints; separate ledgers do not create additional hardware capacity.

## Claim before dispatch

Follow [claims](claims.md) for the comment format, branch discriminator, and stale
claim handling. Before briefing, read the issue's complete comment thread and
check remote branches for competing work. A local roster cannot rule out another
session's claim. Verify an authorized claim write by rereading the issue, and keep
its durable history instead of deleting earlier claim notes.

## File fence across sessions

`claims <path>` sees only local lanes. For each path in a brief, also inspect the
diff of other sessions' live branches against current `origin/main`, for example
`git diff --name-only origin/main...origin/<branch>`. Establish which branches are
live and fetch the refs needed for that comparison. Resolve overlap through
sequencing or a revised assignment; bank work or take the next eligible issue
while the fence is unresolved.

## One candidate per session, serial merges

Separate sessions may each have one candidate. Coordinate their order in the
Ladder and respect the shared review backlog. Merge serially repo-wide under
[review and merge](review-merge.md): re-read the current target and exact candidate
head, land one, then reassess the others. `landing-independence.mjs` is path-based
advice; exit 0 does not replace required verification of the merged tree.

A red `main` takes priority. The introducing change's owner coordinates its fix
with the PM; other sessions avoid competing repairs. A queued `e2e-main` run is
not a failure, and its concurrency group is shared across sessions.

## Bookkeeping

The PM writes the day's release-note batch from the digest's gather of `main`.
[Release-note rules](dispatch.md#release-notes) own format, curation, and cadence;
orchestrators do not send duplicate author lists.

Report the [status pulse](lifecycle.md#status-pulse) to the PM when requested and
authorized. The PM arbitrates file fences, capacity conflicts, and landing order.
