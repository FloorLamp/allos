"use client";

import SubmitButton from "@/components/SubmitButton";

type Kind = "disconnect" | "disable" | "calendar-feed" | "family-feed";
type Action =
  (() => void | Promise<void>) | ((formData: FormData) => void | Promise<void>);

const copy = {
  disconnect: ["Disconnect", "Disconnecting…"],
  disable: ["Disable", "Disabling…"],
  "calendar-feed": ["Disable feed", "Disabling…"],
  "family-feed": ["Disable family feed", "Disabling…"],
} as const;

export default function IntegrationDisconnectButton({
  kind,
  action,
  disabled,
}: {
  kind: Kind;
  action: Action;
  disabled?: boolean;
}) {
  return (
    <form action={action} data-integration-disconnect="">
      <SubmitButton
        className="btn-danger focus-visible:ring-2 focus-visible:ring-rose-500"
        pendingLabel={copy[kind][1]}
        disabled={disabled}
        data-testid={kind === "family-feed" ? "family-feed-disable" : undefined}
      >
        {copy[kind][0]}
      </SubmitButton>
    </form>
  );
}
