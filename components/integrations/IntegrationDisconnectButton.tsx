"use client";

import { useTransition } from "react";
import { useFormStatus } from "react-dom";

type DisconnectKind =
  "disconnect" | "disable" | "calendar-feed" | "family-feed";
type Props = { kind: DisconnectKind; disabled?: boolean } & (
  | {
      serverAction: (formData: FormData) => void | Promise<void>;
      onDisconnect?: never;
    }
  | {
      onDisconnect: () => void | Promise<void>;
      serverAction?: never;
    }
);

const copy = {
  disconnect: ["Disconnect", "Disconnecting…"],
  disable: ["Disable", "Disabling…"],
  "calendar-feed": ["Disable feed", "Disabling…"],
  "family-feed": ["Disable family feed", "Disabling…"],
} as const;

function Control({
  kind,
  disabled = false,
  onDisconnect,
}: Pick<Props, "kind" | "disabled"> & {
  onDisconnect?: () => void | Promise<void>;
}) {
  const { pending: formPending } = useFormStatus();
  const [callbackPending, start] = useTransition();
  const pending = onDisconnect ? callbackPending : formPending;
  return (
    <button
      type={onDisconnect ? "button" : "submit"}
      disabled={disabled || pending}
      onClick={
        onDisconnect ? () => start(async () => await onDisconnect()) : undefined
      }
      aria-busy={pending || undefined}
      data-testid={kind === "family-feed" ? "family-feed-disable" : undefined}
      data-integration-disconnect=""
      className="min-h-11 rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950"
    >
      {copy[kind][pending ? 1 : 0]}
    </button>
  );
}

export default function IntegrationDisconnectButton({
  kind,
  disabled,
  ...binding
}: Props) {
  return binding.serverAction ? (
    <form action={binding.serverAction}>
      <Control kind={kind} disabled={disabled} />
    </form>
  ) : (
    <Control
      kind={kind}
      disabled={disabled}
      onDisconnect={binding.onDisconnect}
    />
  );
}
