"use client";

import { useState } from "react";
import type { Portal, PortalAccount, PortalIdentity } from "@/lib/portals";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  addAccountAction,
  addPortalAction,
  bindIdentityAction,
  removeAccountAction,
  removePortalAction,
  renamePortalAction,
  unbindIdentityAction,
} from "./actions";
import type { ProfileChoice, RunAction } from "./PortalSetup";

// MAINTENANCE, NOT SETUP (#1826). Everything a household touches rarely — the portal and
// login registry, renaming, removing, unbinding, and the manual bind — lives here, behind
// one collapsed disclosure, at every stage.
//
// PROGRESSIVE DISCLOSURE, NOT DELETION. Nothing that worked before is gone; it stopped
// being the first thing a first-time user meets. The manual bind in particular was the
// page's worst element: it rendered as a permanent primary affordance for the exact
// action #1739's design says nobody should ever perform — a human predicting how a portal
// spells a name. It is still here, still works, and is now labelled for what it is.
//
// ROW ACTIONS ARE A ⋯ MENU (#1488). Edit and delete verbs live in the overflow menu on
// each row rather than as bare buttons, so a row shows its identity first and its
// maintenance second, and every destructive one confirms through useConfirm() (#1587) —
// never a native dialog.
export default function PortalManage({
  portals,
  accounts,
  identities,
  profiles,
  writableProfiles,
  isAdmin,
  busy,
  run,
}: {
  portals: Portal[];
  accounts: PortalAccount[];
  identities: PortalIdentity[];
  profiles: ProfileChoice[];
  writableProfiles: ProfileChoice[];
  isAdmin: boolean;
  busy: boolean;
  run: RunAction;
}) {
  const confirm = useConfirm();

  const [portalName, setPortalName] = useState("");
  const [software, setSoftware] = useState("");

  const [accountPortal, setAccountPortal] = useState<number | "">(
    portals[0]?.id ?? ""
  );
  const [accountName, setAccountName] = useState("");

  const [bindAccount, setBindAccount] = useState<number | "">(
    accounts[0]?.id ?? ""
  );
  const [bindLabel, setBindLabel] = useState("");
  const [bindProfile, setBindProfile] = useState<number | "">(
    writableProfiles[0]?.id ?? ""
  );

  // Which row's ⋯ menu is open, and which portal is being renamed inline. Both are
  // single-valued: two open menus or two half-finished renames are states a row list
  // should not be able to reach.
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");

  const profileName = (id: number) =>
    profiles.find((p) => p.id === id)?.name ?? `Profile ${id}`;
  const accountsOf = (portalId: number) =>
    accounts.filter((a) => a.portalId === portalId);
  // A login is worth NAMING in the UI only when the portal has more than one. With a
  // single login the account is an implementation detail of the key, and showing
  // "Default login" next to every patient would teach a concept nobody needs.
  const showsAccount = (portalId: number) => accountsOf(portalId).length > 1;

  return (
    <details className="card" data-testid="portals-manage">
      <summary
        className="cursor-pointer font-semibold text-slate-800 dark:text-slate-100"
        data-testid="portals-manage-toggle"
      >
        Manage portals &amp; logins
      </summary>

      <div className="mt-4 space-y-6">
        {isAdmin && (
          <div className="space-y-3" data-testid="portals-registry">
            <div>
              <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                Portals
              </h3>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                A portal is recorded by name only. Its web address stays in the
                companion tool on your own computer.
              </p>
            </div>

            {portals.length === 0 ? (
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No portals yet.
              </p>
            ) : (
              <ul className="space-y-2">
                {portals.map((p) => (
                  <li
                    key={p.id}
                    data-testid="portal-row"
                    className="rounded-lg border border-black/10 p-3 dark:border-white/10"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                          {p.name}
                        </div>
                        <div className="text-xs text-slate-500 dark:text-slate-400">
                          {/* The slug is what the companion tool's config quotes, so it
                              is shown plainly and never changes when the name does. */}
                          <code>{p.slug}</code>
                          {p.software ? ` · ${p.software}` : ""}
                        </div>
                      </div>
                      <OverflowMenu
                        label={`Actions for ${p.name}`}
                        open={openMenu === `portal-${p.id}`}
                        onOpenChange={(open) =>
                          setOpenMenu(open ? `portal-${p.id}` : null)
                        }
                      >
                        {({ close }) => (
                          <>
                            <button
                              type="button"
                              className={MENU_ITEM}
                              data-testid="portal-rename"
                              onClick={() => {
                                setRenaming(p.id);
                                setRenameText(p.name);
                                close();
                              }}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              className={MENU_ITEM_DANGER}
                              data-testid="portal-remove"
                              onClick={async () => {
                                close();
                                const ok = await confirm({
                                  title: `Remove ${p.name}?`,
                                  message:
                                    "Its logins and every patient mapped on it go too. Documents already imported stay, but they stop naming the portal they came from.",
                                  confirmLabel: "Remove portal",
                                  danger: true,
                                });
                                if (!ok) return;
                                const fd = new FormData();
                                fd.set("portal_id", String(p.id));
                                run(fd, removePortalAction, "Portal removed.");
                              }}
                            >
                              Remove
                            </button>
                          </>
                        )}
                      </OverflowMenu>
                    </div>

                    {/* RENAME IS A SHIPPED ACTION THAT NOTHING RENDERED (#1826).
                        `renamePortalAction` has existed since #1739 — the slug/name split
                        was designed to make renames safe (every tool config quotes the
                        slug, which never moves) — and no UI ever called it. */}
                    {renaming === p.id && (
                      <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
                        <input
                          value={renameText}
                          onChange={(e) => setRenameText(e.target.value)}
                          aria-label={`New name for ${p.name}`}
                          className="input"
                          data-testid="portal-rename-input"
                        />
                        <button
                          type="button"
                          className="btn"
                          disabled={busy || !renameText.trim()}
                          data-testid="portal-rename-save"
                          onClick={() => {
                            const fd = new FormData();
                            fd.set("portal_id", String(p.id));
                            fd.set("name", renameText);
                            run(fd, renamePortalAction, "Portal renamed.");
                            setRenaming(null);
                          }}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          data-testid="portal-rename-cancel"
                          onClick={() => setRenaming(null)}
                        >
                          Cancel
                        </button>
                      </div>
                    )}

                    {/* Logins on this portal — framed as optional: a household with one
                        login never needs to touch it. */}
                    <ul className="mt-2 space-y-1 border-t border-black/5 pt-2 dark:border-white/5">
                      {accountsOf(p.id).map((a) => (
                        <li
                          key={a.id}
                          data-testid="portal-account-row"
                          className="flex items-center justify-between gap-3 text-xs"
                        >
                          <span className="text-slate-600 dark:text-slate-300">
                            {a.name} <code className="ml-1">{a.slug}</code>
                            {/* THE IMPLICIT LOGIN'S PARENTHETICAL IS CONDITIONAL
                                (#1756). "Used when the tool names no login" is true only
                                while this is the portal's ONLY login. The moment a second
                                one exists, resolveAccount REFUSES an account-less request
                                rather than falling back to this row — correct, per the
                                omitted-account rule — so the old copy asserted a fallback
                                that no longer happens, precisely when a household most
                                needs to understand why its tool started erroring. The row
                                itself stays: once there are two logins this one is a real,
                                nameable login that can carry bindings, and hiding it would
                                hide them. */}
                            {a.implicit ? (
                              <span
                                className="ml-1 text-slate-400"
                                data-testid="portal-account-implicit-note"
                              >
                                {accountsOf(a.portalId).length > 1
                                  ? "(the tool must name a login)"
                                  : "(used when the tool names no login)"}
                              </span>
                            ) : null}
                          </span>
                          <OverflowMenu
                            label={`Actions for ${a.name}`}
                            open={openMenu === `account-${a.id}`}
                            onOpenChange={(open) =>
                              setOpenMenu(open ? `account-${a.id}` : null)
                            }
                          >
                            {({ close }) => (
                              <button
                                type="button"
                                className={MENU_ITEM_DANGER}
                                data-testid="portal-account-remove"
                                onClick={async () => {
                                  close();
                                  const ok = await confirm({
                                    title: `Remove the login “${a.name}”?`,
                                    message:
                                      "Every patient mapped on this login is removed with it, and the tool can no longer name it.",
                                    confirmLabel: "Remove login",
                                    danger: true,
                                  });
                                  if (!ok) return;
                                  const fd = new FormData();
                                  fd.set("account_id", String(a.id));
                                  run(
                                    fd,
                                    removeAccountAction,
                                    "Login removed."
                                  );
                                }}
                              >
                                Remove
                              </button>
                            )}
                          </OverflowMenu>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}

            <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
              <input
                value={portalName}
                onChange={(e) => setPortalName(e.target.value)}
                placeholder="Ochsner MyChart"
                aria-label="Portal name"
                className="input"
                data-testid="portal-name"
              />
              <select
                value={software}
                onChange={(e) => setSoftware(e.target.value)}
                aria-label="Portal software"
                className="input"
                data-testid="portal-software"
              >
                <option value="">Software (optional)</option>
                <option value="mychart">Epic MyChart</option>
                <option value="cerner">Cerner / Oracle Health</option>
                <option value="generic-ccd">Other (CCD export)</option>
              </select>
              <button
                type="button"
                onClick={() => {
                  const fd = new FormData();
                  fd.set("name", portalName);
                  fd.set("software", software);
                  run(fd, addPortalAction, "Portal added.");
                  setPortalName("");
                  setSoftware("");
                }}
                disabled={busy || !portalName.trim()}
                className="btn"
                data-testid="portal-add"
              >
                Add portal
              </button>
            </div>

            {portals.length > 0 && (
              <div className="grid gap-2 border-t border-black/5 pt-3 sm:grid-cols-[1fr_1fr_auto] dark:border-white/5">
                <select
                  value={accountPortal}
                  onChange={(e) => setAccountPortal(Number(e.target.value))}
                  aria-label="Portal for the new login"
                  className="input"
                  data-testid="account-portal"
                >
                  {portals.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <input
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  placeholder="Add a login — “Mom”, “dad@example.com”"
                  aria-label="Login nickname"
                  className="input"
                  data-testid="account-name"
                />
                <button
                  type="button"
                  onClick={() => {
                    const fd = new FormData();
                    fd.set("portal_id", String(accountPortal));
                    fd.set("name", accountName);
                    run(fd, addAccountAction, "Login added.");
                    setAccountName("");
                  }}
                  disabled={busy || !accountName.trim() || accountPortal === ""}
                  className="btn"
                  data-testid="account-add"
                >
                  Add login
                </button>
              </div>
            )}
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Add a login only when two people sign in to the same portal with
              their own accounts. A nickname or the account&apos;s email address
              is all allos keeps — never a password, and never the web address
              you sign in at. Both stay in the companion tool on the machine
              that uses them.
            </p>
          </div>
        )}

        {/* THE BINDINGS, WITH THEIR MAINTENANCE VERBS. The steady-state card answers
            "who is mapped, and when was each last checked?"; this list answers "change
            one" — one question each, so the two are not two answers to the same one. */}
        <div className="space-y-3" data-testid="portal-identities">
          <div>
            <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
              Mapped patients
            </h3>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              Anything not mapped here is refused rather than filed under a
              guess.
            </p>
          </div>

          {identities.length === 0 ? (
            <p
              className="text-sm text-slate-500 dark:text-slate-400"
              data-testid="portal-identities-empty"
            >
              No patients mapped yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {identities.map((i) => (
                <li
                  key={i.id}
                  data-testid="portal-identity-row"
                  className="flex items-center justify-between gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      {i.patientLabel}
                    </div>
                    <div className="text-xs text-slate-500 dark:text-slate-400">
                      {i.portalName}
                      {showsAccount(i.portalId)
                        ? ` · ${i.accountName}`
                        : ""} →{" "}
                      {i.ignored ? (
                        <span data-testid="portal-identity-ignored">
                          not synced (ignored)
                        </span>
                      ) : (
                        profileName(i.profileId ?? 0)
                      )}
                    </div>
                  </div>
                  <OverflowMenu
                    label={`Actions for ${i.patientLabel}`}
                    open={openMenu === `identity-${i.id}`}
                    onOpenChange={(open) =>
                      setOpenMenu(open ? `identity-${i.id}` : null)
                    }
                  >
                    {({ close }) =>
                      i.ignored ? (
                        // AN IGNORED ROW IS UN-IGNORED, NOT DELETED. The action already
                        // routes this to `unignorePortalIdentity`, scoped to
                        // `ignored = 1`, so this can never remove a live binding — and
                        // the patient becomes offerable again the next time the tool
                        // reports them.
                        <button
                          type="button"
                          className={MENU_ITEM}
                          data-testid="portal-identity-unignore"
                          onClick={() => {
                            close();
                            const fd = new FormData();
                            fd.set("identity_id", String(i.id));
                            run(
                              fd,
                              unbindIdentityAction,
                              "No longer ignored — the next run offers this patient again."
                            );
                          }}
                        >
                          Stop ignoring
                        </button>
                      ) : (
                        <button
                          type="button"
                          className={MENU_ITEM_DANGER}
                          data-testid="portal-identity-remove"
                          onClick={async () => {
                            close();
                            const ok = await confirm({
                              title: `Unmap ${i.patientLabel}?`,
                              message:
                                "Their next documents are refused instead of filed, until this patient is mapped again. Records already imported stay.",
                              confirmLabel: "Unmap patient",
                              danger: true,
                            });
                            if (!ok) return;
                            // The row id only. The action resolves which profile this
                            // binding points at server-side and gates on that (#1747) —
                            // a profile id sent from here would authorize nothing.
                            const fd = new FormData();
                            fd.set("identity_id", String(i.id));
                            run(fd, unbindIdentityAction, "Mapping removed.");
                          }}
                        >
                          Unmap
                        </button>
                      )
                    }
                  </OverflowMenu>
                </li>
              ))}
            </ul>
          )}

          {/* THE ESCAPE HATCH, LABELLED AS ONE (#1826). */}
          {accounts.length > 0 && writableProfiles.length > 0 && (
            <div className="space-y-2 border-t border-black/5 pt-3 dark:border-white/5">
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Patients normally appear here by themselves after a run, spelled
                the way the portal spells them. Use this only to pre-bind a
                label you know exactly — a guess is refused, not corrected.
              </p>
              <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
                <select
                  value={bindAccount}
                  onChange={(e) => setBindAccount(Number(e.target.value))}
                  aria-label="Portal login"
                  className="input"
                  data-testid="bind-account"
                >
                  {accounts.map((a) => {
                    const portal = portals.find((p) => p.id === a.portalId);
                    return (
                      <option key={a.id} value={a.id}>
                        {portal?.name ?? "Portal"}
                        {showsAccount(a.portalId) ? ` — ${a.name}` : ""}
                      </option>
                    );
                  })}
                </select>
                <input
                  value={bindLabel}
                  onChange={(e) => setBindLabel(e.target.value)}
                  placeholder="Patient as the portal spells it"
                  aria-label="Patient label"
                  className="input"
                  data-testid="bind-label"
                />
                <select
                  value={bindProfile}
                  onChange={(e) => setBindProfile(Number(e.target.value))}
                  aria-label="Profile"
                  className="input"
                  data-testid="bind-profile"
                >
                  {writableProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => {
                    const fd = new FormData();
                    fd.set("account_id", String(bindAccount));
                    fd.set("patient_label", bindLabel);
                    fd.set("profile_id", String(bindProfile));
                    run(fd, bindIdentityAction, "Patient mapped.");
                    setBindLabel("");
                  }}
                  disabled={busy || !bindLabel.trim() || bindAccount === ""}
                  className="btn"
                  data-testid="bind-add"
                >
                  Map
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </details>
  );
}
