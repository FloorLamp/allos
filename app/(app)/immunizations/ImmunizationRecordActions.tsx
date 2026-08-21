"use client";

import { useState } from "react";
import Link from "next/link";
import { IconCopy, IconCheck } from "@tabler/icons-react";
import ModalShell from "@/components/ModalShell";
import OverflowMenu, { MENU_ITEM } from "@/components/OverflowMenu";
import { NOTICE_TONE } from "@/components/Notice";
import SubmitButton from "@/components/SubmitButton";
import { SHARE_TTL_OPTIONS } from "@/lib/share-links";
import type { AppRoute } from "@/lib/hrefs";
import { createImmunizationShareLinkAction } from "./actions";

// Print + Share controls for the immunization record (issue #1849), mirroring the
// medication list's pair: the Print link opens /immunizations/print; Share mints a
// tokenized read-only /share link over the SAME record. Client-only so it can drive
// the share modal + clipboard; the mutation is a Server Action gated by
// requireWriteAccess(). Existing links (any kind) are listed with their Revoke
// button on the passport page, which is the one share-link management surface.
//
// ── ONE TOOLBAR GRAMMAR FOR THE PANE (#3408, item C) ────────────────────────
//
// These used to be two icon-only squares standing beside a bordered "Import
// records" secondary and a full-width primary "Add immunization" — four button
// species in one row, above the list, on every single visit. Records adds are
// rare-cadence by definition (#1497); print, share and import are rarer still.
//
// So the pane gets ONE primary (the add, which stays exactly where it was) and
// everything else folds behind a ⋯. Below `md` that ⋯ is not a menu but a bottom
// ACTION SHEET with tap-floor rows (#3374, via
// components/overlay/AnchoredPanel.tsx) — this file did not have to know that.
//
// THIS FILE OWNS THE MENU RATHER THAN THE PANE, because it owns the share MODAL:
// hoisting the three items into ImmunizationsSection would have left the modal's
// state stranded a component away from the item that opens it, or forced a second
// copy of it. The import LINK is passed in (`extraItems`) because it is the
// PANE's, not the record's — this component stays the record's print/share pair
// and simply hosts the fold.
//
// EVERY ITEM KEEPS ITS TESTID AND ITS ACCESSIBLE NAME. Reaching them is now two
// taps instead of one; what they are and what they do is unchanged, which is why
// e2e/immunization-record-share.spec.ts needed a menu-open and nothing else.
const PRINT_HREF = "/immunizations/print" as AppRoute;
const MANAGE_HREF = "/profile" as AppRoute;

export default function ImmunizationRecordActions({
  extraItems,
}: {
  // Pane-level items that belong in the same fold — the import door today. A
  // render prop, so the caller composes its own link and this file does not grow
  // a second vocabulary of "kinds of menu item".
  extraItems?: (helpers: {
    close: () => void;
    itemClass: string;
  }) => React.ReactNode;
} = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [copied, setCopied] = useState(false);

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setCreatedUrl(null);
    setCopied(false);
    setCreating(true);
    const res = await createImmunizationShareLinkAction(
      new FormData(e.currentTarget)
    );
    setCreating(false);
    if (res.ok) setCreatedUrl(window.location.origin + res.path);
    else setError(res.error);
  }

  async function copy() {
    if (!createdUrl) return;
    try {
      await navigator.clipboard.writeText(createdUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — URL shown for manual copy */
    }
  }

  return (
    <div className="print:hidden">
      <OverflowMenu
        label="Record actions"
        open={menuOpen}
        onOpenChange={setMenuOpen}
        panelClassName="w-56"
      >
        {({ close }) => (
          <>
            {/* A REAL <a>, not a menu item that navigates in JS: it survives the
                pre-hydration window and it can be opened in a new tab, which is
                what someone printing a record for a registrar actually does. */}
            <Link
              href={PRINT_HREF}
              className={MENU_ITEM}
              data-testid="immunization-print-link"
              role="menuitem"
              onClick={close}
            >
              Print immunization record
            </Link>
            <button
              type="button"
              role="menuitem"
              className={MENU_ITEM}
              data-testid="immunization-share-open"
              onClick={() => {
                close();
                setOpen(true);
              }}
            >
              Share immunization record
            </button>
            {extraItems?.({ close, itemClass: MENU_ITEM })}
          </>
        )}
      </OverflowMenu>

      {open && (
        <ModalShell
          title="Share your immunization record"
          onClose={() => setOpen(false)}
        >
          <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
            Create a read-only link anyone can open without logging in — hand it
            to a school registrar, camp, or travel clinic. It shows your
            vaccination record only, and you can revoke it any time from the
            passport page.
          </p>

          <form onSubmit={onCreate} className="mt-4 flex flex-col gap-4">
            <div>
              <label className="label" htmlFor="imm-share-ttl">
                Valid for
              </label>
              <select
                id="imm-share-ttl"
                name="ttl"
                defaultValue="7d"
                className="input sm:w-48"
              >
                {SHARE_TTL_OPTIONS.map((o) => (
                  <option key={o.key} value={o.key}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
            {error && (
              <p className="text-sm text-rose-600 dark:text-rose-400">
                {error}
              </p>
            )}
            <SubmitButton
              disabled={creating}
              pendingLabel="Creating…"
              data-testid="immunization-share-create"
            >
              Create link
            </SubmitButton>
          </form>

          {createdUrl && (
            <div
              className={`mt-4 rounded-lg border p-3 ${NOTICE_TONE.emerald}`}
            >
              <div className="text-xs font-medium text-emerald-800 dark:text-emerald-300">
                Link created — copy it now (it won’t be shown again):
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  readOnly
                  value={createdUrl}
                  onFocus={(e) => e.currentTarget.select()}
                  data-testid="immunization-share-url"
                  className="input font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={copy}
                  className="btn-ghost shrink-0"
                  aria-label="Copy link"
                  title="Copy link"
                >
                  {copied ? (
                    <IconCheck className="h-4 w-4" stroke={1.75} />
                  ) : (
                    <IconCopy className="h-4 w-4" stroke={1.75} />
                  )}
                </button>
              </div>
              <p className="mt-2 text-xs text-emerald-800 dark:text-emerald-300">
                Manage or revoke it under{" "}
                <Link href={MANAGE_HREF} className="font-medium underline">
                  Passport → Share
                </Link>
                .
              </p>
            </div>
          )}
        </ModalShell>
      )}
    </div>
  );
}
