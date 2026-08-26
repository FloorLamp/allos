"use client";

import { DestructiveSubmit } from "@/components/SubmitButton";

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
      <DestructiveSubmit
        pendingLabel={copy[kind][1]}
        disabled={disabled}
        data-testid={kind === "family-feed" ? "family-feed-disable" : undefined}
      >
        {copy[kind][0]}
      </DestructiveSubmit>
    </form>
  );
}
