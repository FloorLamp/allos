"use client";

import { useConfirm } from "@/components/ConfirmDialog";
import SubmitButton, { DestructiveSubmit } from "@/components/SubmitButton";

type Kind = "disconnect" | "disable" | "calendar-feed" | "family-feed";
type Action =
  (() => void | Promise<void>) | ((formData: FormData) => void | Promise<void>);

// OWNER RULING 12 (#4978, 2026-09-10) NARROWS RULING 10, AND THE TWO HALVES ARE
// ONE PROP. A standalone destructive control keeps the filled `danger` only on a
// surface with NO commit of its own; beside a card's commit it takes the quiet
// paint and the red moves to its CONFIRM STEP — the shape #5704 gave the
// training per-row Deletes. Spelled as a union so the quiet paint cannot be
// taken without giving the red somewhere to go: a disconnect that went quiet
// with no confirm would DELETE the destructive signal rather than relocate it,
// and every one of these revokes a token or a grant with no undo.
//
// Six of the seven mounts are the unchanged case — their card carries the
// status header and this control and no commit at all, because each page's
// commit lives on the mutually exclusive not-connected branch.
type CommitNeighbour =
  | { besideCommit?: false; confirmMessage?: never }
  | { besideCommit: true; confirmMessage: string };

type Props = {
  kind: Kind;
  action: Action;
  disabled?: boolean;
} & CommitNeighbour;

const copy = {
  disconnect: ["Disconnect", "Disconnecting…"],
  disable: ["Disable", "Disabling…"],
  "calendar-feed": ["Disable feed", "Disabling…"],
  "family-feed": ["Disable family feed", "Disabling…"],
} as const;

const testIdFor = (kind: Kind) =>
  kind === "family-feed" ? "family-feed-disable" : undefined;

export default function IntegrationDisconnectButton(props: Props) {
  const { kind, action, disabled } = props;
  if (props.besideCommit)
    return (
      <ConfirmedDisconnect
        kind={kind}
        action={action}
        disabled={disabled}
        message={props.confirmMessage}
      />
    );
  return (
    <form action={action} data-integration-disconnect="">
      <DestructiveSubmit
        pendingLabel={copy[kind][1]}
        disabled={disabled}
        data-testid={testIdFor(kind)}
      >
        {copy[kind][0]}
      </DestructiveSubmit>
    </form>
  );
}

// The quiet half, as its OWN component so the loud six never require a
// `ConfirmProvider` above them for a dialog they do not open.
//
// The confirm is awaited INSIDE the form action, which is the shape #5336
// settled for this app (components/IntakeItemForm.tsx does the same): the
// dialog's store is external, so React commits the sheet even while the action
// is pending, and the caller stays a plain `<form action>` with the primitive
// owning its submission state.
function ConfirmedDisconnect({
  kind,
  action,
  disabled,
  message,
}: {
  kind: Kind;
  action: Action;
  disabled?: boolean;
  message: string;
}) {
  const confirm = useConfirm();
  const [label, pendingLabel] = copy[kind];
  // A no-argument action is assignable to the one-argument form; naming that
  // here keeps the call below free of a cast.
  const run: (formData: FormData) => void | Promise<void> = action;
  return (
    <form
      data-integration-disconnect=""
      action={async (formData) => {
        const ok = await confirm({
          title: `${label}?`,
          message,
          confirmLabel: label,
          danger: true,
        });
        if (ok) await run(formData);
      }}
    >
      <SubmitButton
        pendingLabel={pendingLabel}
        disabled={disabled}
        data-testid={testIdFor(kind)}
      >
        {label}
      </SubmitButton>
    </form>
  );
}
