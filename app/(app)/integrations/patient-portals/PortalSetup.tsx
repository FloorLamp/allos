"use client";

import { useState, useTransition } from "react";
import type {
  PendingIdentity,
  Portal,
  PortalAccount,
  PortalIdentity,
} from "@/lib/portals";
import {
  addAccountAction,
  addPortalAction,
  bindIdentityAction,
  bindPendingIdentityAction,
  dismissPendingIdentityAction,
  ignorePendingIdentityAction,
  removeAccountAction,
  removePortalAction,
  unbindIdentityAction,
} from "./actions";

// The Patient portals card's setup surface (#1739): register the portals you use, name
// the logins that reach them, then bind each portal patient to a profile.
//
// The binding list is the important half. One portal login often covers several people
// through proxy access, and the companion tool reports whatever label the portal shows —
// so this screen is where a household says "the patient the portal calls 'Jane Q. Doe' is
// THIS profile". Anything unbound is refused at upload rather than filed under a guess,
// which is why the empty state says so plainly instead of looking like a setup step
// someone forgot.
//
// LOGINS are shown only once a portal has more than one, or the user opens the section:
// the single-login household is most of them, and the third component of the key is
// invisible to them by design (their portal's implicit login is named in exactly one
// place — here — and never in their tool config).
//
// Every action returns a typed outcome and this component renders it: binding can
// legitimately refuse (an unknown login, an empty label, a profile the caller may not
// write), so nothing here reports success unconditionally.

export interface ProfileChoice {
  id: number;
  name: string;
}

// "Last synced" for one (login, patient), computed server-side from sync events.
export interface IdentityStatusView {
  accountId: number;
  patientLabel: string;
  lastOkAt: string | null;
  lastFailedAt: string | null;
}

function day(stamp: string): string {
  return stamp.slice(0, 10);
}

export default function PortalSetup({
  portals,
  accounts,
  identities,
  pending,
  statuses,
  profiles,
  writableProfiles,
  isAdmin,
  canManagePending,
}: {
  portals: Portal[];
  accounts: PortalAccount[];
  identities: PortalIdentity[];
  // Identities the acquirer reported that allos could not place — discovered on a run, or
  // refused at upload time (#1739). Empty for a login that could not act on them.
  pending: PendingIdentity[];
  statuses: IdentityStatusView[];
  // Every profile this login can REACH — for rendering a binding's target name.
  profiles: ProfileChoice[];
  // The profiles this login may WRITE — the only ones a picker may offer, since binding
  // onto anything else is refused at the gate anyway.
  writableProfiles: ProfileChoice[];
  isAdmin: boolean;
  canManagePending: boolean;
}) {
  // `busy` (not `pending`): a pending IDENTITY is a domain noun on this screen, so the
  // transition flag gets the unambiguous name.
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

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

  // Which profile each pending row is about to be mapped onto. Per row, because two
  // reported patients on one login are usually two different people — a single shared
  // select would quietly carry the previous choice onto the next person.
  //
  // UNSET UNTIL CHOSEN (#1756). It used to default to the first writable profile, which
  // put "file this patient under whoever sorts first" one click away — the exact misfiling
  // this whole surface exists to prevent, and the one mistake nothing downstream can
  // catch. So the picker opens on a placeholder and Map stays disabled until a human has
  // actually said who this is.
  const [pendingProfile, setPendingProfile] = useState<Record<number, number>>(
    {}
  );
  const chosenFor = (pendingId: number): number | "" =>
    pendingProfile[pendingId] ?? "";

  function run(
    fd: FormData,
    fn: (f: FormData) => Promise<{ ok: boolean; error?: string }>,
    okMsg: string
  ) {
    setError(null);
    setStatus(null);
    start(async () => {
      const r = await fn(fd);
      if (r.ok) setStatus(okMsg);
      else setError(r.error ?? "That didn't work.");
    });
  }

  const profileName = (id: number) =>
    profiles.find((p) => p.id === id)?.name ?? `Profile ${id}`;
  const accountsOf = (portalId: number) =>
    accounts.filter((a) => a.portalId === portalId);
  const statusFor = (accountId: number, label: string) =>
    statuses.find(
      (s) => s.accountId === accountId && s.patientLabel === label
    ) ?? null;

  // A login is worth NAMING in the UI only when the portal has more than one. With a
  // single login the account is an implementation detail of the key, and showing
  // "Default login" next to every patient would teach a concept nobody needs.
  const showsAccount = (portalId: number) => accountsOf(portalId).length > 1;

  return (
    <div className="space-y-6">
      {isAdmin && (
        <div className="card space-y-3" data-testid="portals-registry">
          <div>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Portals
            </h2>
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              A portal is recorded by name only. The web address lives in the
              companion tool on your own computer — allos never stores one, so
              nothing here can send the tool to the wrong site.
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
                        {/* The slug is what the companion tool's config quotes, so it is
                            shown plainly and never changes when the name does. */}
                        <code>{p.slug}</code>
                        {p.software ? ` · ${p.software}` : ""}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn-ghost shrink-0 text-sm"
                      disabled={busy}
                      data-testid="portal-remove"
                      onClick={() => {
                        const fd = new FormData();
                        fd.set("portal_id", String(p.id));
                        run(fd, removePortalAction, "Portal removed.");
                      }}
                    >
                      Remove
                    </button>
                  </div>

                  {/* Logins on this portal. Shown always for admins (this IS the setup
                      surface) but framed as optional: a household with one login never
                      needs to touch it. */}
                  <ul className="mt-2 space-y-1 border-t border-black/5 pt-2 dark:border-white/5">
                    {accountsOf(p.id).map((a) => (
                      <li
                        key={a.id}
                        data-testid="portal-account-row"
                        className="flex items-center justify-between gap-3 text-xs"
                      >
                        <span className="text-slate-600 dark:text-slate-300">
                          {a.name} <code className="ml-1">{a.slug}</code>
                          {/* THE IMPLICIT LOGIN'S PARENTHETICAL IS CONDITIONAL (#1756).
                              "Used when the tool names no login" is true only while this
                              is the portal's ONLY login. The moment a second one exists,
                              resolveAccount REFUSES an account-less request rather than
                              falling back to this row — correct, per the omitted-account
                              rule — so the old copy asserted a fallback that no longer
                              happens, precisely when a household most needs to understand
                              why its tool started erroring. The row itself stays: once
                              there are two logins this one is a real, nameable login that
                              can carry bindings, and hiding it would hide them. */}
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
                        <button
                          type="button"
                          className="btn-ghost shrink-0 text-xs"
                          disabled={busy}
                          data-testid="portal-account-remove"
                          onClick={() => {
                            const fd = new FormData();
                            fd.set("account_id", String(a.id));
                            run(fd, removeAccountAction, "Login removed.");
                          }}
                        >
                          Remove
                        </button>
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
                placeholder="Add a login — “Mom”, “Dad”"
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
            Only add a login when two people sign in to the same portal with
            their own accounts. A nickname is all allos stores — never a
            username or a password, which stay in the companion tool on the
            machine that uses them.
          </p>
        </div>
      )}

      {/* WAITING TO BE MAPPED (#1739). The tool reports the proxy patients it saw, so
          this list is normally populated by DISCOVERY rather than by failure — the user
          binds a label allos was told, verbatim, instead of predicting how a portal
          renders a name. A refused upload lands here too, as the safety net for a patient
          who appears between runs. */}
      {canManagePending && pending.length > 0 && (
        <div className="card space-y-3" data-testid="pending-identities">
          <div>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Waiting to be mapped
            </h2>
            {/* All three buttons are named here, because "Ignore" and "Not now" look
                alike and mean opposite things — one is a durable "never sync this
                person", the other only clears the prompt. */}
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
              The tool reported these patients and allos has not been told who
              they are, so nothing has been filed for them. Map one to a profile
              and the next run lands normally; ignore a patient whose records
              belong somewhere else; or choose Not now to clear the prompt until
              the tool reports them again.
            </p>
          </div>

          <ul className="space-y-2">
            {pending.map((p) => (
              <li
                key={p.id}
                data-testid="pending-row"
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                    {p.patientLabel}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {p.portalName}
                    {p.accountImplicit ? "" : ` · ${p.accountName}`} · first
                    seen {day(p.firstSeenAt)} · last seen {day(p.lastSeenAt)}
                    {p.seenCount > 1 ? ` · seen ${p.seenCount}×` : ""}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {writableProfiles.length > 0 && (
                    <>
                      <select
                        value={chosenFor(p.id)}
                        onChange={(e) =>
                          setPendingProfile((prev) => ({
                            ...prev,
                            [p.id]: Number(e.target.value),
                          }))
                        }
                        aria-label={`Profile for ${p.patientLabel}`}
                        className="input"
                        data-testid="pending-profile"
                      >
                        {/* No preselection: a misfiled patient is the harm this card
                            exists to prevent, so the choice must be made, not merely
                            left alone. */}
                        <option value="">Choose profile…</option>
                        {writableProfiles.map((pr) => (
                          <option key={pr.id} value={pr.id}>
                            {pr.name}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="btn shrink-0 text-sm"
                        disabled={busy || chosenFor(p.id) === ""}
                        data-testid="pending-map"
                        onClick={() => {
                          const chosen = chosenFor(p.id);
                          if (chosen === "") return;
                          // The label is NOT sent — the action reads it off the
                          // pending row, so what gets bound is exactly what was
                          // reported, character for character.
                          const fd = new FormData();
                          fd.set("pending_id", String(p.id));
                          fd.set("profile_id", String(chosen));
                          run(fd, bindPendingIdentityAction, "Patient mapped.");
                        }}
                      >
                        Map to profile
                      </button>
                    </>
                  )}
                  <button
                    type="button"
                    className="btn-ghost shrink-0 text-sm"
                    disabled={busy}
                    data-testid="pending-ignore"
                    title="Never sync this patient — they stay refused, and stop appearing here"
                    onClick={() => {
                      const fd = new FormData();
                      fd.set("pending_id", String(p.id));
                      run(
                        fd,
                        ignorePendingIdentityAction,
                        "Patient ignored — their records will not be filed here."
                      );
                    }}
                  >
                    Ignore
                  </button>
                  <button
                    type="button"
                    className="btn-ghost shrink-0 text-sm"
                    disabled={busy}
                    data-testid="pending-dismiss"
                    title="Clear this prompt — it returns if the tool reports the patient again"
                    onClick={() => {
                      const fd = new FormData();
                      fd.set("pending_id", String(p.id));
                      run(fd, dismissPendingIdentityAction, "Cleared for now.");
                    }}
                  >
                    Not now
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card space-y-3" data-testid="portal-identities">
        <div>
          {/* "Mapped patients", not "Who is who" (#1756): it and "Waiting to be mapped"
              are the same noun in its two states, so they should read as a pair. */}
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Mapped patients
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            One portal login often covers several people. Map each patient
            exactly as the portal spells them. Anything not mapped here is
            refused rather than filed under a guess — so a new family member
            appearing on the portal shows up as something to fix, never as
            records on the wrong person.
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
            {identities.map((i) => {
              const st = statusFor(i.accountId, i.patientLabel);
              return (
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
                    {/* Per-(login, patient) "Last synced" — a household with two portals
                        and three patients has six answers to that question, so the single
                        per-profile connection stamp cannot carry it. A quiet check still
                        counts; a failure never erases the last good one. */}
                    {st && (
                      <div
                        className="text-xs text-slate-500 dark:text-slate-400"
                        data-testid="portal-identity-status"
                      >
                        {st.lastOkAt
                          ? `Last checked ${day(st.lastOkAt)}`
                          : "Not checked yet"}
                        {st.lastFailedAt
                          ? ` · last failure ${day(st.lastFailedAt)}`
                          : ""}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    className="btn-ghost shrink-0 text-sm"
                    disabled={busy}
                    data-testid="portal-identity-remove"
                    onClick={() => {
                      // The row id only. The action resolves which profile this binding
                      // points at server-side and gates on that (#1747) — a profile id
                      // sent from here would authorize nothing.
                      const fd = new FormData();
                      fd.set("identity_id", String(i.id));
                      run(fd, unbindIdentityAction, "Mapping removed.");
                    }}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {accounts.length > 0 && writableProfiles.length > 0 && (
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
        )}
      </div>

      {error && (
        <p
          className="text-sm text-rose-600 dark:text-rose-400"
          data-testid="portals-error"
        >
          {error}
        </p>
      )}
      {status && (
        <p
          className="text-sm text-emerald-600 dark:text-emerald-400"
          data-testid="portals-status"
        >
          {status}
        </p>
      )}
    </div>
  );
}
