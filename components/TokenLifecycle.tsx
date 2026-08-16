import type { ChangeEvent } from "react";
import { IconAlertTriangle, IconClock } from "@tabler/icons-react";
import RelativeTime from "@/components/RelativeTime";
import {
  TOKEN_EXPIRY_CHOICES,
  type TokenExpiryChoice,
  type TokenLifecycleStatus,
} from "@/lib/token-lifecycle";

// Shared, universal (no client hooks) UI for the long-lived token surfaces (issue
// #24): the calendar `.ics` feed and the Health Connect ingest token. Rendered
// from both a server component (Health Connect page) and a client component
// (calendar config), so it deliberately avoids client-only APIs — the only client
// piece is RelativeTime, which is fine to render from either tree.

const EXPIRY_LABEL: Record<TokenExpiryChoice, string> = {
  never: "Never expires",
  "90d": "Expires in 90 days",
  "1y": "Expires in 1 year",
};

// THE labeled expiry dropdown for mint/rotate (#2959). Three byte-identical
// copies of this lived in the calendar feed, the consolidated family feed and
// Health Connect, differing only in their test id — three more places for the
// expiry vocabulary to drift from the one that already owned it.
//
// Serves both call shapes, because both exist:
//
//   * CONTROLLED (`value` + `onChange`) — a client component holds the choice in
//     state and passes it to a server action as an argument.
//   * UNCONTROLLED (`name` + `defaultValue`) — a plain server-action <form> reads
//     it from the submitted FormData. `defaultValue` seeds the safe "never".
//
// The presence of `value` picks the mode, so a <select> never receives both
// `value` and `defaultValue` — the React warning this avoids by construction.
// `name` is dropped when controlled, where the value never travels as form data.
export function ExpirySelect({
  name = "expiry",
  id,
  value,
  onChange,
  defaultValue = "never",
  disabled,
  testId = "token-expiry-select",
}: {
  name?: string;
  id?: string;
  value?: TokenExpiryChoice;
  onChange?: (v: TokenExpiryChoice) => void;
  defaultValue?: TokenExpiryChoice;
  disabled?: boolean;
  testId?: string;
}) {
  const controlled = value !== undefined;
  return (
    <label className="block">
      <span className="label">Expiry</span>
      <select
        id={id}
        name={controlled ? undefined : name}
        {...(controlled
          ? {
              value,
              onChange: (e: ChangeEvent<HTMLSelectElement>) =>
                onChange?.(e.target.value as TokenExpiryChoice),
            }
          : { defaultValue })}
        disabled={disabled}
        className="input"
        data-testid={testId}
      >
        {TOKEN_EXPIRY_CHOICES.map((c) => (
          <option key={c} value={c}>
            {EXPIRY_LABEL[c]}
          </option>
        ))}
      </select>
    </label>
  );
}

// The last-used / expiry summary plus the "Expired" and "consider rotating" cues.
// `status` drives the strong signals; the timestamp lines are always shown when
// present so the user can see when the token was last exercised.
export function TokenLifecycleNote({
  status,
  createdAt,
  lastUsedAt,
  expiresAt,
}: {
  status: TokenLifecycleStatus;
  createdAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
}) {
  return (
    <div className="space-y-1.5 text-xs text-slate-500 dark:text-slate-400">
      <p data-testid="token-last-used">
        Last used:{" "}
        {lastUsedAt ? (
          <RelativeTime value={lastUsedAt} className="font-medium" />
        ) : (
          <span className="font-medium">never</span>
        )}
      </p>
      {createdAt && (
        <p>
          Created: <RelativeTime value={createdAt} className="font-medium" />
        </p>
      )}
      <p data-testid="token-expiry">
        {expiresAt ? (
          <>
            {status === "expired" ? "Expired on" : "Expires on"}{" "}
            <span className="font-medium">{expiresAt.slice(0, 10)}</span>
          </>
        ) : (
          <span>Never expires</span>
        )}
      </p>

      {status === "expired" && (
        <p
          className="flex items-start gap-1.5 text-rose-600 dark:text-rose-400"
          data-testid="token-expired-note"
        >
          <IconAlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This token has <strong>expired</strong> and no longer works — rotate
            it to get a fresh one.
          </span>
        </p>
      )}
      {status === "rotate" && (
        <p
          className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400"
          data-testid="token-rotate-note"
        >
          <IconClock className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            This token is over a year old — <strong>consider rotating</strong>{" "}
            it.
          </span>
        </p>
      )}
    </div>
  );
}
