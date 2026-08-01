"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import type {
  PendingIdentity,
  Portal,
  PortalAccount,
  PortalIdentity,
} from "@/lib/portals";
import type { PortalSetupStage } from "@/lib/portal-setup-stage";
import type { PortalStatusLine } from "@/lib/portal-status";
import IntegrationSyncHistoryLink from "@/components/IntegrationSyncHistoryLink";
import PortalManage from "./PortalManage";
import {
  addPortalAction,
  bindPendingIdentityAction,
  dismissPendingIdentityAction,
  ignorePendingIdentityAction,
  requestSyncAction,
} from "./actions";

// The Patient portals page's ONE stage card, plus the collapsed Manage section (#1826).
//
// The page used to render every card the integration owns, always — a fresh user met five
// empty states in five dialects, and a steady-state household scrolled past setup forms it
// would never touch again. Now `portalSetupStage()` decides where the household is and
// this renders only that step, with one primary CTA. Everything else is one click away in
// <PortalManage>, from any stage.
//
// The binding list is still the important half of the whole feature. One portal login
// often covers several people through proxy access, and the companion tool reports
// whatever label the portal shows — so this screen is where a household says "the patient
// the portal calls 'Jane Q. Doe' is THIS profile". Anything unbound is refused at upload
// rather than filed under a guess.
//
// Every action returns a typed outcome and this component renders it: binding can
// legitimately refuse (an unknown login, an empty label, a profile the caller may not
// write), so nothing here reports success unconditionally.

export interface ProfileChoice {
  id: number;
  name: string;
}

// One portal login's open sync request, as the card renders it (#1757). The LINE is
// formatted server-side by the ONE shared formatter (lib/sync-requests.ts), so the card,
// the Upcoming item and the digest line cannot word the same ask three ways.
export interface SyncRequestView {
  accountId: number;
  line: string;
}

// "Last synced" for one (login, patient), computed server-side from sync events.
export interface IdentityStatusView {
  accountId: number;
  patientLabel: string;
  lastOkAt: string | null;
  lastFailedAt: string | null;
}

// Run a server action and render its typed outcome. Shared with <PortalManage> so both
// halves of the page report success and refusal the same way, from one place.
export type RunAction = (
  fd: FormData,
  fn: (f: FormData) => Promise<{ ok: boolean; error?: string }>,
  okMsg: string
) => void;

function day(stamp: string): string {
  return stamp.slice(0, 10);
}

export default function PortalSetup({
  stage,
  portals,
  accounts,
  identities,
  pending,
  statuses,
  syncRequests,
  profiles,
  writableProfiles,
  isAdmin,
  canManagePending,
  statusLine,
  lastSuccessAt,
}: {
  // Where this household is, derived from the data (lib/portal-setup-stage.ts).
  stage: PortalSetupStage;
  portals: Portal[];
  accounts: PortalAccount[];
  identities: PortalIdentity[];
  // Identities the acquirer reported that allos could not place — discovered on a run, or
  // refused at upload time (#1739). Empty for a login that could not act on them.
  pending: PendingIdentity[];
  statuses: IdentityStatusView[];
  // The OPEN sync requests, one per portal login at most (#1757).
  syncRequests: SyncRequestView[];
  // Every profile this login can REACH — for rendering a binding's target name.
  profiles: ProfileChoice[];
  // The profiles this login may WRITE — the only ones a picker may offer, since binding
  // onto anything else is refused at the gate anyway.
  writableProfiles: ProfileChoice[];
  isAdmin: boolean;
  canManagePending: boolean;
  // The ONE status sentence (#1756), decided server-side by one pure function.
  statusLine: PortalStatusLine;
  lastSuccessAt: string | null;
}) {
  // `busy` (not `pending`): a pending IDENTITY is a domain noun on this screen, so the
  // transition flag gets the unambiguous name.
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  // Stage 1 owns the add-portal form itself, so it keeps its own field state; every other
  // stage reaches the same form through <PortalManage>.
  const [firstPortalName, setFirstPortalName] = useState("");
  const [firstPortalSoftware, setFirstPortalSoftware] = useState("");

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

  const run: RunAction = (fd, fn, okMsg) => {
    setError(null);
    setStatus(null);
    start(async () => {
      const r = await fn(fd);
      if (r.ok) setStatus(okMsg);
      else setError(r.error ?? "That didn't work.");
    });
  };

  const profileName = (id: number) =>
    profiles.find((p) => p.id === id)?.name ?? `Profile ${id}`;
  const accountsOf = (portalId: number) =>
    accounts.filter((a) => a.portalId === portalId);
  const requestFor = (accountId: number) =>
    syncRequests.find((r) => r.accountId === accountId) ?? null;
  const portalOf = (portalId: number) => portals.find((p) => p.id === portalId);
  const statusFor = (accountId: number, label: string) =>
    statuses.find(
      (s) => s.accountId === accountId && s.patientLabel === label
    ) ?? null;
  const showsAccount = (portalId: number) => accountsOf(portalId).length > 1;

  // Manage holds the registry (admins) and the binding maintenance (anyone who could
  // change one, plus anyone who can see one at all). A viewer with neither has nothing to
  // manage, so the disclosure itself does not render — an empty drawer is a worse answer
  // than no drawer.
  const hasManage =
    isAdmin || writableProfiles.length > 0 || identities.length > 0;
  // Stage 1 is deliberately alone on the page: "add your first portal" IS the registry
  // form, so a second copy of it inside Manage would be the same field twice.
  const showsManage = hasManage && stage !== "no-portals";

  // The mapped patients, as the steady-state summary shows them: never the ignored rows,
  // which are a "do not sync this person" statement rather than a patient being kept up
  // to date. Those stay visible in Manage, where changing one lives.
  const mapped = identities.filter((i) => !i.ignored);

  return (
    <div className="space-y-6">
      <section
        className="card space-y-3"
        data-testid="portal-stage"
        data-stage={stage}
      >
        {stage === "no-portals" && (
          <>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Add the portal you use
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Bring in visit summaries, labs, medications and immunizations from
              a hospital or clinic portal. A small companion tool signs in on
              your own computer — your password, and even the portal&apos;s web
              address, never leave that machine.
            </p>
            {isAdmin ? (
              <>
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <input
                    value={firstPortalName}
                    onChange={(e) => setFirstPortalName(e.target.value)}
                    placeholder="Ochsner MyChart"
                    aria-label="Portal name"
                    className="input"
                    data-testid="portal-name"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      const fd = new FormData();
                      fd.set("name", firstPortalName);
                      fd.set("software", firstPortalSoftware);
                      run(fd, addPortalAction, "Portal added.");
                      setFirstPortalName("");
                      setFirstPortalSoftware("");
                    }}
                    disabled={busy || !firstPortalName.trim()}
                    className="btn"
                    data-testid="portal-add"
                  >
                    Add your first portal
                  </button>
                </div>
                {/* The software tag is display metadata and a hint for the tool — never
                    a required decision, so it stays behind a toggle on first contact. */}
                <details className="text-xs text-slate-500 dark:text-slate-400">
                  <summary className="cursor-pointer">
                    Which software does it run? (optional)
                  </summary>
                  <select
                    value={firstPortalSoftware}
                    onChange={(e) => setFirstPortalSoftware(e.target.value)}
                    aria-label="Portal software"
                    className="input mt-2"
                    data-testid="portal-software"
                  >
                    <option value="">Not sure</option>
                    <option value="mychart">Epic MyChart</option>
                    <option value="cerner">Cerner / Oracle Health</option>
                    <option value="generic-ccd">Other (CCD export)</option>
                  </select>
                </details>
              </>
            ) : (
              // A member cannot register a portal — the registry is instance-scoped
              // vocabulary a household shares. Naming no portal here is deliberate: an
              // empty VISIBLE registry means "none of them are yours", and saying which
              // ones exist elsewhere is the disclosure #1796 closed.
              <p className="text-sm text-slate-500 dark:text-slate-400">
                No portal is set up for you yet. An admin on this instance can
                add one.
              </p>
            )}
          </>
        )}

        {stage === "create-token" && (
          <>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Create a token for the computer that will run the tool
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              The companion tool needs one to push documents in. Name it for the
              device — &ldquo;Mom&apos;s laptop&rdquo; — so retiring a machine
              never disturbs the others.
            </p>
            <div>
              <Link
                href="/settings/tokens"
                className="btn inline-flex"
                data-testid="portal-token-cta"
              >
                Go to Settings → API tokens
              </Link>
            </div>
          </>
        )}

        {stage === "first-run" && (
          <>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Run the tool on that computer
            </h2>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              Start the companion tool. It signs in the way you would — you type
              the two-factor code — and reports which patients that login
              covers. Those patients then appear here to be mapped.
            </p>
            {/* The ONLY stage that needs this: it explains a wait a first-time user is
                otherwise left guessing about. */}
            <p className="text-xs text-slate-500 dark:text-slate-400">
              The first run fetches your full history and can take several
              minutes — the portal prepares the export on its own schedule.
              Later runs only pick up what changed.
            </p>
          </>
        )}

        {stage === "map-patients" && (
          <>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              {pending.length === 1
                ? "One patient to map"
                : `${pending.length} patients to map`}
            </h2>
            {/* ONE STATUS COMPUTATION, RENDERED WHERE IT APPLIES. This is the same
                `portalStatusLine` element the steady card carries, never a second one —
                the two stages are mutually exclusive. It leads here because its
                first-contact branch (#1756) is exactly this card's sentence ("The tool
                reported 3 patients on X — map them below to finish setup"), and because a
                portal-level FAILURE must not be hidden behind a pending row. The page
                formats the one result rather than writing its own version of it. */}
            <p
              data-testid="portals-status-line"
              data-tone={statusLine.tone}
              className={
                statusLine.tone === "attention"
                  ? "text-sm text-amber-700 dark:text-amber-300"
                  : "text-sm text-slate-600 dark:text-slate-300"
              }
            >
              {statusLine.text}
            </p>
            {/* All three verbs are named, because "Ignore" and "Not now" look alike and
                mean opposite things — one is a durable "never sync this person", the
                other only clears the prompt. */}
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Map a patient to a profile and the next run lands normally; ignore
              one whose records belong somewhere else; or choose Not now to
              clear the prompt until the tool reports them again.
            </p>

            <ul className="space-y-2" data-testid="pending-identities">
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
                        {/* The one primary CTA of this stage — a button, not a menu
                            entry: the ⋯ menu is for maintenance verbs, never the next
                            step. */}
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
                            run(
                              fd,
                              bindPendingIdentityAction,
                              "Patient mapped."
                            );
                          }}
                        >
                          Map
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
                        run(
                          fd,
                          dismissPendingIdentityAction,
                          "Cleared for now."
                        );
                      }}
                    >
                      Not now
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}

        {stage === "steady" && (
          <>
            {/* ONE STATUS HOME (#1826). The sentence, its reassurance line and the
                history link live here and nowhere else — the per-patient rows below are
                the same question at a finer grain, not a second answer to this one. */}
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Status
            </h2>
            <p
              data-testid="portals-status-line"
              data-tone={statusLine.tone}
              className={
                statusLine.tone === "attention"
                  ? "text-sm text-amber-700 dark:text-amber-300"
                  : "text-sm text-slate-600 dark:text-slate-300"
              }
            >
              {statusLine.text}
            </p>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              A run that finds nothing new still counts as a check, so a quiet
              week reads as healthy rather than broken.
            </p>
            <IntegrationSyncHistoryLink lastSuccessAt={lastSuccessAt} />

            {mapped.length > 0 && (
              <ul
                className="space-y-1 border-t border-black/5 pt-3 dark:border-white/5"
                data-testid="portal-patients"
              >
                {mapped.map((i) => {
                  const st = statusFor(i.accountId, i.patientLabel);
                  return (
                    <li
                      key={i.id}
                      data-testid="portal-patient-row"
                      className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm"
                    >
                      <span className="text-slate-700 dark:text-slate-200">
                        {i.patientLabel}{" "}
                        <span className="text-slate-500 dark:text-slate-400">
                          → {profileName(i.profileId ?? 0)}
                        </span>
                      </span>
                      {/* Per-(login, patient) "Last synced" — a household with two
                          portals and three patients has six answers to that question, so
                          the single per-profile connection stamp cannot carry it. A quiet
                          check still counts; a failure never erases the last good one. */}
                      <span
                        className="text-xs text-slate-500 dark:text-slate-400"
                        data-testid="portal-patient-status"
                      >
                        {st?.lastOkAt
                          ? `Last checked ${day(st.lastOkAt)}`
                          : "Not checked yet"}
                        {st?.lastFailedAt
                          ? ` · last failure ${day(st.lastFailedAt)}`
                          : ""}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* SYNC REQUESTS (#1757). Allos cannot run a portal sync — the whole premise
                of this integration — so there is no "Sync now". What it CAN do is ask the
                person whose machine holds the login, which is a different promise and is
                worded as one: a request is never a schedule. */}
            {canManagePending && accounts.length > 0 && (
              <div
                className="space-y-2 border-t border-black/5 pt-3 dark:border-white/5"
                data-testid="portal-sync-requests"
              >
                <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                  Ask someone to run a sync
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  A run needs a person at the computer that holds the login.
                  Asking puts a calm reminder in front of whoever usually runs
                  it; it expires on its own, and the next reported run clears
                  it.
                </p>
                <ul className="space-y-1">
                  {accounts.map((a) => {
                    const open = requestFor(a.id);
                    const portal = portalOf(a.portalId);
                    return (
                      <li
                        key={a.id}
                        data-testid="sync-request-row"
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <span className="text-slate-700 dark:text-slate-200">
                          {portal?.name ?? "Portal"}
                          {showsAccount(a.portalId) ? ` (${a.name})` : ""}
                          {open ? (
                            <span
                              className="ml-2 text-xs text-brand-700 dark:text-brand-300"
                              data-testid="sync-request-open"
                            >
                              {open.line}
                            </span>
                          ) : null}
                        </span>
                        <button
                          type="button"
                          className="btn-ghost shrink-0 text-xs"
                          disabled={busy || open != null}
                          data-testid="sync-request-ask"
                          onClick={() => {
                            const fd = new FormData();
                            fd.set("account_id", String(a.id));
                            run(fd, requestSyncAction, "Sync requested.");
                          }}
                        >
                          Request sync
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </>
        )}
      </section>

      {showsManage && (
        <PortalManage
          portals={portals}
          accounts={accounts}
          identities={identities}
          profiles={profiles}
          writableProfiles={writableProfiles}
          isAdmin={isAdmin}
          busy={busy}
          run={run}
        />
      )}

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
