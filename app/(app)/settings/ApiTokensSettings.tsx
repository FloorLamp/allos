"use client";

import { useState, useTransition } from "react";
import {
  API_TOKEN_SCOPES,
  apiTokenScopeLabel,
  apiTokenScopeSummary,
  type ApiTokenScope,
} from "@/lib/api-token-format";
import type { ApiTokenSummary } from "@/lib/api-tokens";
import { CopyButton } from "@/components/TokenRow";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatTimestamp } from "@/lib/format-date";
import { createApiTokenAction, revokeApiTokenAction } from "./token-actions";

// API tokens (issue #1734) — mint, list, revoke. The shape follows the Health
// Connect token precedent: the secret is shown EXACTLY ONCE, right after minting, in
// a panel that says so; there is no "show it again" affordance, because the instance
// no longer has it (only the scrypt hash is stored). Losing it means minting another
// and revoking the old one.
//
// `showOwner` is the admin view: an admin sees every login's tokens (names and
// last-used stamps only — never secret material) and may revoke any of them, the same
// visibility they already have over logins and grants. A member sees only their own.
//
// Both actions return TYPED outcomes and this component renders each one. A revoke can
// legitimately refuse (already revoked, or not the caller's), so "Revoke" never
// reports success unconditionally.

function ScopeBadge({ scope }: { scope: ApiTokenScope }) {
  return (
    <span
      className="badge shrink-0 bg-slate-100 text-slate-600 dark:bg-ink-750 dark:text-slate-300"
      title={apiTokenScopeSummary(scope)}
      data-testid="api-token-scope"
    >
      {apiTokenScopeLabel(scope)}
    </span>
  );
}

export default function ApiTokensSettings({
  tokens,
  showOwner,
  canManage,
}: {
  tokens: ApiTokenSummary[];
  showOwner: boolean;
  canManage: boolean;
}) {
  const formatPrefs = useFormatPrefs();
  const fmt = (ts: string) => formatTimestamp(ts, formatPrefs, { zone: "utc" });
  const [pending, start] = useTransition();
  const [name, setName] = useState("");
  // The capability vocabulary ships exactly ONE scope (#1734's deliberate v1
  // friction), so there is no choice to offer — the mint form states the
  // capability as text instead of a one-option select (#1869 item 1). When a
  // second scope lands, this becomes a picker again.
  const scope: ApiTokenScope = API_TOKEN_SCOPES[0];
  const [minted, setMinted] = useState<{ token: string; name: string } | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  function mint() {
    setError(null);
    setStatus(null);
    const fd = new FormData();
    fd.set("name", name);
    fd.set("scope", scope);
    start(async () => {
      const r = await createApiTokenAction(fd);
      if (r.ok) {
        setMinted({ token: r.token, name: r.name });
        setName("");
      } else setError(r.error);
    });
  }

  function revoke(id: number) {
    setError(null);
    setStatus(null);
    const fd = new FormData();
    fd.set("token_id", String(id));
    start(async () => {
      const r = await revokeApiTokenAction(fd);
      if (r.ok) setStatus("Token revoked.");
      else setError(r.error);
    });
  }

  return (
    <div className="space-y-6">
      <div className="card space-y-4" data-testid="api-token-mint">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Create an API token
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            A token lets a script or command-line tool act as your login without
            a browser. It can only ever do what you can do: revoking your access
            to a profile revokes it for every token you hold.
          </p>
        </div>

        {canManage && (
          <div className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Name
                </span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Laptop CLI"
                  className="input w-full"
                  data-testid="api-token-name"
                />
              </label>
              <div className="space-y-1">
                <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
                  Capability
                </span>
                <p
                  className="py-1 text-sm font-medium text-slate-700 dark:text-slate-200"
                  data-testid="api-token-capability"
                >
                  {apiTokenScopeLabel(scope)}
                </p>
              </div>
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              {apiTokenScopeSummary(scope)}
            </p>
            <button
              type="button"
              onClick={mint}
              disabled={pending || !name.trim()}
              className="btn"
              data-testid="api-token-create"
            >
              Create token
            </button>
          </div>
        )}

        {minted && (
          <div
            className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3"
            data-testid="api-token-secret"
          >
            <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
              Copy “{minted.name}” now — this is the only time it is shown.
              Allos stores only a hash of it, so it cannot be shown again.
            </p>
            {/* COPY, not select-and-drag (#1756). This is the one string in the app
                that must be transcribed exactly and is shown exactly once — a missed
                character means minting again. The shared CopyButton is the same
                affordance every other token and feed URL already offers. */}
            <div className="flex min-w-0 items-start gap-2">
              <code className="block min-w-0 flex-1 break-all rounded-sm bg-black/5 p-2 font-mono text-sm dark:bg-white/5">
                {minted.token}
              </code>
              <CopyButton value={minted.token} testid="api-token-copy" />
            </div>
            <button
              type="button"
              onClick={() => setMinted(null)}
              className="btn-ghost text-sm"
              data-testid="api-token-secret-dismiss"
            >
              I&rsquo;ve saved it
            </button>
          </div>
        )}

        {error && (
          <p
            className="text-sm text-rose-600 dark:text-rose-400"
            data-testid="api-token-error"
          >
            {error}
          </p>
        )}
        {status && (
          <p
            className="text-sm text-emerald-600 dark:text-emerald-400"
            data-testid="api-token-status"
          >
            {status}
          </p>
        )}
      </div>

      <div className="card space-y-3" data-testid="api-token-list">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          {showOwner ? "All API tokens" : "Your API tokens"}
        </h2>
        {tokens.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            No tokens yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {tokens.map((t) => (
              <li
                key={t.id}
                data-testid="api-token-row"
                className="flex items-start justify-between gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
              >
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      {t.name}
                    </span>
                    <ScopeBadge scope={t.scope} />
                    {showOwner && (
                      <span className="text-xs text-slate-500 dark:text-slate-400">
                        {t.username}
                      </span>
                    )}
                  </div>
                  <dl className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-500 dark:text-slate-400">
                    <div className="flex gap-1">
                      <dt>Last used</dt>
                      <dd
                        className="font-medium text-slate-700 dark:text-slate-200"
                        data-testid="api-token-last-used"
                      >
                        {t.lastUsedAt ? `${fmt(t.lastUsedAt)} UTC` : "never"}
                      </dd>
                    </div>
                    <div className="flex gap-1">
                      <dt>Created</dt>
                      <dd>{fmt(t.createdAt)} UTC</dd>
                    </div>
                  </dl>
                </div>
                {canManage && (
                  <button
                    type="button"
                    onClick={() => revoke(t.id)}
                    disabled={pending}
                    className="btn-ghost shrink-0 text-sm"
                    data-testid="api-token-revoke"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
