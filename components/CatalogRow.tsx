"use client";

import { useState, type ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";
import DestinationLink from "./DestinationLink";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
  type MenuActionResult,
} from "./OverflowMenu";
import { useOptionalConfirm } from "./ConfirmDialog";
import { CatalogFormDialog, type CatalogEditorProps } from "./CatalogEditor";

export default function CatalogRow<Props, Item>({
  name,
  href,
  facts,
  control,
  inactive,
  kind,
  inactiveLabel,
  editor,
  deleteAction,
  testId,
}: {
  name: string;
  /**
   * The subject's own page, when it has one. ABSENT IS A REAL CASE, not a caller that
   * forgot: a declaration (#5865) is read whole on the row it is written on and has no
   * detail page to go to, and a link to nowhere is worse than no link. The name renders
   * as text then, with no destination indicator promising a door.
   */
  href?: AppRoute;
  facts: ReactNode;
  control: ReactNode;
  inactive: boolean;
  kind: string;
  inactiveLabel: string;
  editor: CatalogEditorProps<Props, Item>;
  /**
   * The row's delete, when the catalog offers one. A bound Server Action, so the
   * CONFIRM and the toast stay here rather than being written again at each catalog:
   * the question is always "delete this <kind>", and the outcome is rendered through
   * the menu's own `runAction` (a typed refusal toasts its error, #2133).
   *
   * Absent where the lifecycle control IS the whole answer — retiring equipment keeps
   * the history that references it, so there is nothing safe to offer.
   */
  deleteAction?: (fd: FormData) => Promise<MenuActionResult>;
  testId?: string;
}) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  // OPTIONAL, the shared-primitive posture (see ConfirmDialog): this row is rendered
  // by catalogs inside the app shell, where a provider always stands, but a primitive
  // that CRASHES outside one is a primitive the next surface cannot reuse.
  //
  // WHAT THAT POSTURE DOES NOT CARRY IS THE DELETE. ModalShell, the only other
  // consumer, fails OPEN when no provider stands — it dismisses a modal, so the cost
  // of not asking is unsaved input, which is bad and bounded. The delete below says
  // "This cannot be undone" in its own copy, so the two directions are not symmetric
  // and the pattern must not be inherited whole: with nobody to ask, it refuses.
  const confirm = useOptionalConfirm();
  return (
    <li
      data-testid={testId}
      data-retired={inactive ? "1" : "0"}
      className="flex flex-wrap items-center justify-between gap-3 py-3"
    >
      <div className="min-w-0 flex-1 space-y-1">
        {href ? (
          <DestinationLink href={href} className="wrap-anywhere font-medium">
            {name}
          </DestinationLink>
        ) : (
          <p className="wrap-anywhere font-medium">{name}</p>
        )}
        <p className="text-xs text-slate-500 dark:text-slate-400">{facts}</p>
        {inactive && (
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {inactiveLabel}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3">
        {control}
        <OverflowMenu
          itemName={name}
          kind={kind}
          open={menu}
          onOpenChange={setMenu}
        >
          {({ close, runAction }) => (
            <>
              <button
                type="button"
                role="menuitem"
                className={MENU_ITEM}
                onClick={() => {
                  close();
                  setEditing(true);
                }}
              >
                Edit
              </button>
              {deleteAction && (
                <button
                  type="button"
                  role="menuitem"
                  className={MENU_ITEM_DANGER}
                  onClick={async () => {
                    // FAIL CLOSED. A question nobody can be asked is not a question
                    // that was answered yes, and the refusal is SAID rather than
                    // silent: a delete that quietly does nothing is the same mystery
                    // as a delete that quietly happens. It rides the menu's own
                    // outcome channel (#2133), which is what renders every other
                    // typed refusal here — and `no-alert` rules out the browser's
                    // dialog as a stand-in, correctly.
                    if (!confirm) {
                      await runAction(
                        async () => ({
                          ok: false as const,
                          error: `Couldn't ask you to confirm deleting ${name}, so nothing was deleted.`,
                        }),
                        new FormData(),
                        ""
                      );
                      return;
                    }
                    // The menu stands down the moment the decision opens over it
                    // (#2599, handled by OverflowMenu itself), so a cancelled delete
                    // leaves no backdrop behind to eat the next tap.
                    if (
                      !(await confirm({
                        title: `Delete ${kind.toLowerCase()}`,
                        message: `Delete ${name}? This cannot be undone.`,
                        confirmLabel: "Delete",
                        danger: true,
                      }))
                    )
                      return;
                    await runAction(
                      deleteAction,
                      new FormData(),
                      `Deleted ${name}`
                    );
                  }}
                >
                  Delete
                </button>
              )}
            </>
          )}
        </OverflowMenu>
      </div>
      {editing && (
        <CatalogFormDialog {...editor} onClose={() => setEditing(false)} />
      )}
    </li>
  );
}
