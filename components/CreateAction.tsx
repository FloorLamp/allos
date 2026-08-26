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
    dialogTitle: "Add a practice",
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
    dialogTitle?: `Add ${string}`;
    housing: "page" | "section";
  }
>;

export type CreateActionKind = keyof typeof CREATE_ACTIONS;
export type CreateActionLabel =
  (typeof CREATE_ACTIONS)[CreateActionKind]["label"];

export interface CreateActionDeclaration {
  kind: CreateActionKind;
  available?: boolean;
  control: ReactElement;
}

const CreateActionKindContext = createContext<CreateActionKind | null>(null);

function useCreateActionKind(): CreateActionKind {
  const kind = useContext(CreateActionKindContext);
  if (kind === null) {
    throw new Error("Registered create controls require CreateAction");
  }
  return kind;
}

export function useCreateActionLabel(): CreateActionLabel {
  return CREATE_ACTIONS[useCreateActionKind()].label;
}

export function useCreateActionDialogTitle(): `Add ${string}` {
  const action = CREATE_ACTIONS[useCreateActionKind()];
  return "dialogTitle" in action ? action.dialogTitle : action.label;
}

export default function CreateAction({
  declaration,
  housing,
}: {
  declaration: CreateActionDeclaration;
  housing: "page" | "section";
}) {
  if (declaration.available === false) return null;
  if (housing !== CREATE_ACTIONS[declaration.kind].housing)
    throw new Error(
      `${declaration.kind} create action requires ${CREATE_ACTIONS[declaration.kind].housing} housing`
    );
  return (
    <CreateActionKindContext value={declaration.kind}>
      {declaration.control}
    </CreateActionKindContext>
  );
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
  createAction?: CreateActionDeclaration;
  action?: ReactNode;
}) {
  const createAvailable =
    createAction && createAction.available !== false ? createAction : null;
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
          {createAvailable ? (
            <CreateAction declaration={createAvailable} housing="section" />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
