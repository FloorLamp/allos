"use client";

import { IconCopyCheck, IconEyeOff, IconGitMerge } from "@tabler/icons-react";
import SubmitButton from "@/components/SubmitButton";

type Payload = Readonly<Record<string, string | number>>;
type FormAction<K extends string, Detail = null> = readonly [
  kind: K,
  detail: Detail,
  action: (formData: FormData) => void | Promise<void>,
  payload: Payload,
];
type PressAction<K extends string, Detail = null> = readonly [
  kind: K,
  detail: Detail,
  onPress: () => void,
];
type PairActions = readonly [
  keeper: FormAction<"keeper", string> | PressAction<"keeper", string>,
  alternateKeeper:
    | FormAction<"alternate-keeper", string>
    | PressAction<"alternate-keeper", string>,
  keepBoth: FormAction<"keep-both">,
  dismiss: FormAction<"dismiss">,
];
type ClusterActions = readonly [
  keeper: PressAction<"cluster-keeper", number>,
  keepAll: PressAction<"keep-all">,
  dismiss: PressAction<"dismiss">,
];
export type DuplicateResolution = PairActions | ClusterActions;
type Descriptor = DuplicateResolution[number];
type ControlProps = { action: Descriptor; pending: boolean };

function ResolutionControl({ action, pending }: ControlProps) {
  const [kind, detail] = action;
  const label =
    kind === "keeper"
      ? `Merge, keep ${detail}`
      : kind === "alternate-keeper"
        ? `Keep ${detail} instead`
        : kind === "cluster-keeper"
          ? `Merge ${detail} into keeper`
          : kind === "keep-both"
            ? "Keep both"
            : kind === "keep-all"
              ? "Keep all"
              : "Dismiss";
  const primary = kind === "keeper" || kind === "cluster-keeper";
  const Icon = primary
    ? IconGitMerge
    : kind === "keep-both" || kind === "keep-all"
      ? IconCopyCheck
      : kind === "dismiss"
        ? IconEyeOff
        : null;
  const props = {
    className: primary ? "btn btn-sm" : "btn-ghost btn-sm",
    disabled: pending,
    "data-testid":
      kind === "keeper"
        ? "dup-merge-primary"
        : kind === "alternate-keeper"
          ? "dup-merge-secondary"
          : kind === "cluster-keeper"
            ? "dup-cluster-merge"
            : undefined,
  };
  const contents = (
    <>
      {Icon && <Icon className="h-4 w-4" stroke={1.75} />}
      {label}
    </>
  );

  if (action.length === 3) {
    return (
      <button type="button" onClick={action[2]} {...props}>
        {contents}
      </button>
    );
  }
  return (
    <form action={action[2]}>
      {Object.entries(action[3]).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton {...props}>{contents}</SubmitButton>
    </form>
  );
}

export default function DuplicateResolutionActions({
  actions,
  pending = false,
}: {
  actions: DuplicateResolution;
  pending?: boolean;
}) {
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-2"
      data-testid="duplicate-resolution-actions"
    >
      {actions.map((action) => (
        <ResolutionControl key={action[0]} action={action} pending={pending} />
      ))}
    </div>
  );
}
