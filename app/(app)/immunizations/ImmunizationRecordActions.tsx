"use client";

import { useState } from "react";
import Link from "next/link";
import ModalShell from "@/components/ModalShell";
import CreatedShareLink from "@/components/CreatedShareLink";
import OverflowMenu, { MENU_ITEM } from "@/components/OverflowMenu";
import MyChartImport from "./MyChartImport";
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
// copy of it.
//
// AND IT RENDERS THE IMPORT ITEM ITSELF, VIA A BOOLEAN. The first attempt took a
// render prop — `extraItems({ close, itemClass })` — so the pane could compose
// its own item. That is a FUNCTION crossing the server/client boundary from a
// Server Component, which React refuses, and the whole Immunizations route
// rendered its error boundary. (Measured, not reasoned: every assertion on the
// route failed as "element(s) not found" against a page reading "Something went
// wrong".) A boolean crosses that boundary fine, and the coupling it costs is one
// import of a sibling in this same directory.
//
// EVERY ITEM KEEPS ITS TESTID AND ITS ACCESSIBLE NAME. Reaching them is now two
// taps instead of one; what they are and what they do is unchanged, which is why
// e2e/immunization-record-share.spec.ts needed a menu-open and nothing else.
const PRINT_HREF = "/immunizations/print" as AppRoute;
const MANAGE_HREF = "/profile" as AppRoute;

export default function ImmunizationRecordActions({
  includeImport = false,
}: {
  // Fold the pane's import door in with the record's own rare actions. The
  // caller is a Server Component, so this is a BOOLEAN and not a render prop —
  // see above.
  includeImport?: boolean;
} = {}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function onCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setCreatedUrl(null);
    setCreating(true);
    const res = await createImmunizationShareLinkAction(
      new FormData(e.currentTarget)
    );
    setCreating(false);
    if (res.ok) setCreatedUrl(window.location.origin + res.path);
    else setError(res.error);
  }

  return (
    <div className="print:hidden">
      <OverflowMenu
        kind="Record"
        // A SURFACE menu, not a row menu: print, share and import act on the
        // immunization record as a whole, so the record IS the thing named. It is
        // registered as such in lib/__tests__/overflow-menu-identity.test.ts.
        itemName="Immunizations"
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
            {includeImport && (
              <MyChartImport menuItemClass={MENU_ITEM} onNavigate={close} />
            )}
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
            <>
              <CreatedShareLink
                value={createdUrl}
                valueTestId="immunization-share-url"
              />
              <p className="mt-2 text-xs text-emerald-800 dark:text-emerald-300">
                Manage or revoke it under{" "}
                <Link href={MANAGE_HREF} className="font-medium underline">
                  Passport → Share
                </Link>
                .
              </p>
            </>
          )}
        </ModalShell>
      )}
    </div>
  );
}
