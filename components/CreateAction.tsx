"use client";

import {
  createContext,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";

// The closed semantic vocabulary for page- and section-level creates. The
// registry owns copy and housing; callers get no label, styling, or
// visual-variant seam.
export const CREATE_ACTIONS = {
  medication: {
    label: "Add medication",
    housing: "page",
  },
  practice: {
    label: "Add practice",
    housing: "page",
  },
  "training-activity": {
    label: "Add activity",
    housing: "page",
  },
  protocol: {
    label: "Add protocol",
    housing: "section",
  },
  goal: {
    label: "Add goal",
    housing: "section",
  },
  routine: {
    label: "Add routine",
    housing: "section",
  },
  equipment: {
    label: "Add equipment",
    housing: "section",
  },
  supplement: {
    label: "Add supplement",
    housing: "section",
  },
} as const satisfies Record<
  string,
  {
    label: `Add ${string}`;
    housing: "page" | "section";
  }
>;

export type CreateActionKind = keyof typeof CREATE_ACTIONS;
export type CreateActionLabel =
  (typeof CREATE_ACTIONS)[CreateActionKind]["label"];

export interface CreateActionProps {
  kind: CreateActionKind;
  available?: boolean;
  children: ReactElement;
}

export type CreateActionElement = ReactElement<
  CreateActionProps,
  typeof CreateAction
>;

const CreateActionLabelContext = createContext<CreateActionLabel | null>(null);

export function useCreateActionLabel(): CreateActionLabel {
  const label = useContext(CreateActionLabelContext);
  if (label === null) {
    throw new Error("Registered create controls require CreateAction");
  }
  return label;
}

export default function CreateAction({
  kind,
  available = true,
  children,
}: CreateActionProps) {
  if (!available) return null;
  return (
    <CreateActionLabelContext value={CREATE_ACTIONS[kind].label}>
      {children}
    </CreateActionLabelContext>
  );
}

function createActionIsAvailable(action: CreateActionElement): boolean {
  return action.props.available !== false;
}

// One structural home for section creates. The host, rather than an arbitrary
// caller row, owns the heading/action split and validates section housing. It
// deliberately offers no class, style, render, or visual-variant API.
export function SectionCreateHeader({
  title,
  subtitle,
  leading,
  createAction,
  action,
}: {
  title: string;
  subtitle?: ReactNode;
  leading?: ReactElement;
  createAction?: CreateActionElement;
  action?: ReactNode;
}) {
  const createAvailable =
    createAction && createActionIsAvailable(createAction) ? createAction : null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-start gap-3">
        {leading ? <div className="shrink-0">{leading}</div> : null}
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-800 dark:text-slate-100">
            {title}
          </h2>
          {subtitle ? (
            <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
              {subtitle}
            </p>
          ) : null}
        </div>
      </div>
      {createAvailable || action ? (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          {action}
          {createAvailable}
        </div>
      ) : null}
    </div>
  );
}
