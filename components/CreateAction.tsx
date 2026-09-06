"use client";

import {
  createContext,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react";

export type CreateActionHousing = "page" | "section";

// The closed semantic vocabulary for page- and section-level creates. The
// registry owns copy and housing; callers get no label, styling, or
// visual-variant seam. A kind lists EVERY housing it is mounted in (#4667):
// medication has a page door and the illness fold's section door, and a kind
// that could declare only one forced the second door to hand-roll its trigger.
export const CREATE_ACTIONS = {
  medication: {
    label: "Add medication",
    housing: ["page", "section"],
  },
  practice: {
    label: "Add practice",
    dialogTitle: "Add a practice",
    housing: ["page"],
  },
  "training-activity": {
    label: "Add activity",
    housing: ["page"],
  },
  protocol: {
    label: "Add protocol",
    housing: ["section"],
  },
  goal: {
    label: "Add goal",
    housing: ["section"],
  },
  routine: {
    label: "Add routine",
    housing: ["section"],
  },
  equipment: {
    label: "Add equipment",
    housing: ["section"],
  },
  supplement: {
    label: "Add supplement",
    housing: ["section"],
  },
} as const satisfies Record<
  string,
  {
    label: `Add ${string}`;
    dialogTitle?: `Add ${string}`;
    housing: readonly [CreateActionHousing, ...CreateActionHousing[]];
  }
>;

export type CreateActionKind = keyof typeof CREATE_ACTIONS;
export type CreateActionLabel =
  (typeof CREATE_ACTIONS)[CreateActionKind]["label"];
// The kinds that declared housing H — what a host of that housing may mount.
export type HousedKind<H extends CreateActionHousing> = {
  [
    K in CreateActionKind
  ]: H extends (typeof CREATE_ACTIONS)[K]["housing"][number] ? K : never;
}[CreateActionKind];

export interface CreateActionDeclaration<
  K extends CreateActionKind = CreateActionKind,
> {
  kind: K;
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

export default function CreateAction<H extends CreateActionHousing>({
  declaration,
  housing,
}: {
  declaration: CreateActionDeclaration<HousedKind<H>>;
  housing: H;
}) {
  if (declaration.available === false) return null;
  const declared: readonly CreateActionHousing[] =
    CREATE_ACTIONS[declaration.kind].housing;
  if (!declared.includes(housing))
    throw new Error(
      `${declaration.kind} create action requires ${declared.join(" or ")} housing`
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
  createAction?: CreateActionDeclaration<HousedKind<"section">>;
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
