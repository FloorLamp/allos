"use client";

import SubmitButton from "@/components/SubmitButton";

type Kind = "disconnect" | "disable" | "calendar-feed" | "family-feed";
type Action =
  (() => void | Promise<void>) | ((formData: FormData) => void | Promise<void>);
type Props = { kind: Kind; action: Action; disabled?: boolean };

const copy = {
  disconnect: ["Disconnect", "Disconnecting…"],
  disable: ["Disable", "Disabling…"],
  "calendar-feed": ["Disable feed", "Disabling…"],
  "family-feed": ["Disable family feed", "Disabling…"],
} as const;

export default function IntegrationDisconnectButton(props: Props) {
  const { kind, action, disabled } = props;
  return (
    <form action={action} data-integration-disconnect="">
      <SubmitButton
        className="min-h-11 rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50 focus:outline-hidden focus-visible:ring-2 focus-visible:ring-rose-800 disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-0 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950 dark:focus-visible:ring-rose-200"
        pendingLabel={copy[kind][1]}
        disabled={disabled}
        data-testid={kind === "family-feed" ? "family-feed-disable" : undefined}
      >
        {copy[kind][0]}
      </SubmitButton>
    </form>
  );
}
