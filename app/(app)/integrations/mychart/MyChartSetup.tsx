"use client";

import { useState, useTransition } from "react";
import type { Portal, PortalIdentity } from "@/lib/portals";
import {
  addPortalAction,
  bindIdentityAction,
  removePortalAction,
  unbindIdentityAction,
} from "./actions";

// The MyChart card's setup surface (#1739): register the portals you use, then bind each
// portal patient to a profile.
//
// The binding list is the important half. One portal login often covers several people
// through proxy access, and the companion tool reports whatever label the portal shows —
// so this screen is where a household says "the patient the portal calls 'Jane Q. Doe' is
// THIS profile". Anything unbound is refused at upload rather than filed under a guess,
// which is why the empty state says so plainly instead of looking like a setup step
// someone forgot.
//
// Every action returns a typed outcome and this component renders it: binding can
// legitimately refuse (an unknown portal, an empty label, a profile the caller may not
// write), so nothing here reports success unconditionally.

export interface ProfileChoice {
  id: number;
  name: string;
}

export default function MyChartSetup({
  portals,
  identities,
  profiles,
  isAdmin,
}: {
  portals: Portal[];
  identities: PortalIdentity[];
  profiles: ProfileChoice[];
  isAdmin: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const [slug, setSlug] = useState("");
  const [portalName, setPortalName] = useState("");

  const [bindPortal, setBindPortal] = useState<number | "">(
    portals[0]?.id ?? ""
  );
  const [bindLabel, setBindLabel] = useState("");
  const [bindProfile, setBindProfile] = useState<number | "">(
    profiles[0]?.id ?? ""
  );

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

  function addPortal() {
    const fd = new FormData();
    fd.set("slug", slug);
    fd.set("name", portalName);
    run(fd, addPortalAction, "Portal added.");
    setSlug("");
    setPortalName("");
  }

  function bind() {
    const fd = new FormData();
    fd.set("portal_id", String(bindPortal));
    fd.set("patient_label", bindLabel);
    fd.set("profile_id", String(bindProfile));
    run(fd, bindIdentityAction, "Patient mapped.");
    setBindLabel("");
  }

  const profileName = (id: number) =>
    profiles.find((p) => p.id === id)?.name ?? `Profile ${id}`;

  return (
    <div className="space-y-6">
      {isAdmin && (
        <div className="card space-y-3" data-testid="mychart-portals">
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
                  data-testid="mychart-portal-row"
                  className="flex items-center justify-between gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                      {p.name}
                    </div>
                    <code className="text-xs text-slate-500 dark:text-slate-400">
                      {p.slug}
                    </code>
                  </div>
                  <button
                    type="button"
                    className="btn-ghost shrink-0 text-sm"
                    disabled={pending}
                    data-testid="mychart-portal-remove"
                    onClick={() => {
                      const fd = new FormData();
                      fd.set("portal_id", String(p.id));
                      run(fd, removePortalAction, "Portal removed.");
                    }}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="ochsner"
              aria-label="Portal id"
              className="input"
              data-testid="mychart-portal-slug"
            />
            <input
              value={portalName}
              onChange={(e) => setPortalName(e.target.value)}
              placeholder="Ochsner MyChart"
              aria-label="Portal name"
              className="input"
              data-testid="mychart-portal-name"
            />
            <button
              type="button"
              onClick={addPortal}
              disabled={pending || !slug.trim() || !portalName.trim()}
              className="btn"
              data-testid="mychart-portal-add"
            >
              Add portal
            </button>
          </div>
        </div>
      )}

      <div className="card space-y-3" data-testid="mychart-identities">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Who is who
          </h2>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            One portal login often covers several people. Map each patient
            exactly as the portal spells them. Anything not mapped here is
            refused rather than filed under a guess — so a new family member
            appearing on the portal shows up as a failure you can fix, never as
            records on the wrong person.
          </p>
        </div>

        {identities.length === 0 ? (
          <p
            className="text-sm text-slate-500 dark:text-slate-400"
            data-testid="mychart-identities-empty"
          >
            No patients mapped yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {identities.map((i) => (
              <li
                key={i.id}
                data-testid="mychart-identity-row"
                className="flex items-center justify-between gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10"
              >
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                    {i.patientLabel}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400">
                    {i.portalName} → {profileName(i.profileId)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-ghost shrink-0 text-sm"
                  disabled={pending}
                  data-testid="mychart-identity-remove"
                  onClick={() => {
                    const fd = new FormData();
                    fd.set("identity_id", String(i.id));
                    fd.set("profile_id", String(i.profileId));
                    run(fd, unbindIdentityAction, "Mapping removed.");
                  }}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {portals.length > 0 && profiles.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]">
            <select
              value={bindPortal}
              onChange={(e) => setBindPortal(Number(e.target.value))}
              aria-label="Portal"
              className="input"
              data-testid="mychart-bind-portal"
            >
              {portals.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              value={bindLabel}
              onChange={(e) => setBindLabel(e.target.value)}
              placeholder="Patient as the portal spells it"
              aria-label="Patient label"
              className="input"
              data-testid="mychart-bind-label"
            />
            <select
              value={bindProfile}
              onChange={(e) => setBindProfile(Number(e.target.value))}
              aria-label="Profile"
              className="input"
              data-testid="mychart-bind-profile"
            >
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={bind}
              disabled={pending || !bindLabel.trim() || bindPortal === ""}
              className="btn"
              data-testid="mychart-bind-add"
            >
              Map
            </button>
          </div>
        )}
      </div>

      {error && (
        <p
          className="text-sm text-rose-600 dark:text-rose-400"
          data-testid="mychart-error"
        >
          {error}
        </p>
      )}
      {status && (
        <p
          className="text-sm text-emerald-600 dark:text-emerald-400"
          data-testid="mychart-status"
        >
          {status}
        </p>
      )}
    </div>
  );
}
