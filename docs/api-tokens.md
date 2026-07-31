# API tokens

Allos is a login-gated app: every screen and every Server Action authenticates from a
session cookie. An **API token** is the way to let something that is not a browser — a
script, a cron job, a command-line tool on another machine — act as one of your logins.

Tokens live under **Settings → Account & security → API tokens**.

## What a token is

A token is **tied to a login**, and it is **capability-scoped**.

Tied to a login means the token has no permissions of its own. It is a way to _present_
a login, and the instance works out what that login may do at the moment of each
request, from its current role and its current profile grants. Three consequences worth
being explicit about:

- If you take away a login's access to a profile, every token that login holds loses
  that profile at the same instant. There is nothing to hunt down and re-issue.
- If a login is promoted or demoted, its tokens follow immediately.
- Deleting a login deletes its tokens.

Capability-scoped means the token says what it is for. Today there is exactly one
capability:

| Capability         | What it allows                                                                          |
| ------------------ | --------------------------------------------------------------------------------------- |
| `upload:documents` | Add medical documents to the profiles this login can write to. It cannot read anything. |

That scope is deliberately **write-only**. A token that leaks can put documents into
your record — which you will see, in Data → Review — but cannot read a single value back
out of the instance. Read capabilities are not implemented; when they are, they will be
separate scopes you opt into per token, and an old token will never silently gain one.

## Creating a token

1. Go to **Settings → Account & security → API tokens**.
2. Give it a name that says where it will live — `laptop CLI`, `home server cron`. The
   name is only for you; it is how you decide which one to revoke later.
3. Choose the capability and press **Create token**.

The token is then shown **once**:

```
17.<the secret half>
```

Copy it now. Allos stores only a scrypt hash of the secret, exactly as it stores
passwords, so there is no way — for you, for an admin, or for anyone who reads the
database file — to display it again. If you lose it, create a new token and revoke the
old one.

The part before the dot is the token's id. It is not secret: it is what lets the server
find the one row to verify against instead of comparing your secret to every token in
the instance.

## Using a token

Send it as a bearer token:

```bash
curl -H "Authorization: Bearer $ALLOS_TOKEN" https://allos.example/api/...
```

Keep it in an environment variable or a secrets file, not in a command line — command
lines show up in shell history and in other users' process lists.

## Revoking

Press **Revoke** on the token's row. It stops working on the very next request; there is
no cache and no grace period. Revoking is also the right response to "I'm not sure where
that token ended up" — creating a replacement costs seconds.

Revoked tokens disappear from the list. Their row is kept internally so the id is spent
forever and can never be reissued.

## Expiry

There is none, on purpose. A token lives until it is revoked or its login is deleted,
and the list shows you when each one was last used so an unused token is easy to spot
and remove. Time-limited tokens will arrive with a capability that needs them.

## Who sees what

Members manage their own tokens. Admins additionally see every login's tokens — names,
capabilities and last-used times, never secrets — which is the same visibility they
already have over logins and grants, and the only way to notice a stale credential left
behind on someone else's login.

## For developers

- `lib/api-token-format.ts` — the capability vocabulary, the `<id>.<secret>` wire
  format, and the scope-demand rule. Pure, no database.
- `lib/api-tokens.ts` — mint/list/revoke, plus `authenticateApiToken()`, the single
  helper every bearer route authenticates through.
- Migration `127-api-tokens.ts` — the `api_tokens` table. It is login-owned (no
  `profile_id`), so it is not in `lib/owned-tables.ts`.

`authenticateApiToken()` **authenticates only**. It answers "which login is this, and
does its token carry the capability this endpoint demands" — nothing more. Whether that
login may write to a particular profile is authorization, it is profile-shaped, and it
stays with the route, which composes the same explicit gate `app/share-target/route.ts`
documents:

```ts
isDemoRestricted(isDemoMode(), login.role) ||
  accessForProfile(login.id, login.role, profileId) !== "write";
```

A token is a way to present a login, never an exemption from what that login may do.

Two rules for anyone adding a bearer route:

- **Put it on the `lib/public-paths.ts` allowlist.** The Edge middleware is a coarse
  cookie-presence check and would answer a tokened POST with a 307 redirect to `/login`,
  re-posting the body at a page route. The allowlist only buys the handler the right to
  answer for itself; the handler's own `authenticateApiToken()` call _is_ the gate.
- **Rate-limit before authenticating.** Verification is scrypt — real CPU and memory per
  attempt, by design — so an unauthenticated caller can make the server work. Key the
  limit on the presented token's id, never its secret, exactly as
  `app/api/integrations/health-connect/ingest` does.
