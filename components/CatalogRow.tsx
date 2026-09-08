"use client";

import { useState, type ReactNode } from "react";
import type { AppRoute } from "@/lib/hrefs";
import DestinationLink from "./DestinationLink";
import OverflowMenu, { MENU_ITEM } from "./OverflowMenu";
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
  testId,
}: {
  name: string;
  href: AppRoute;
  facts: ReactNode;
  control: ReactNode;
  inactive: boolean;
  kind: string;
  inactiveLabel: string;
  editor: CatalogEditorProps<Props, Item>;
  testId?: string;
}) {
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  return (
    <li
      data-testid={testId}
      data-retired={inactive ? "1" : "0"}
      className="flex flex-wrap items-center justify-between gap-3 py-3"
    >
      <div className="min-w-0 flex-1 space-y-1">
        <DestinationLink href={href} className="wrap-anywhere font-medium">
          {name}
        </DestinationLink>
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
          {({ close }) => (
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
          )}
        </OverflowMenu>
      </div>
      {editing && (
        <CatalogFormDialog {...editor} onClose={() => setEditing(false)} />
      )}
    </li>
  );
}
