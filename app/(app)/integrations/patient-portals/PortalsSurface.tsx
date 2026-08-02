"use client";

import Link from "next/link";
import { useState, useTransition, type ReactNode } from "react";
import type {
  PortalChecklistItem,
  PortalSetupStage,
} from "@/lib/portal-setup-stage";
import type { PortalStatusTone } from "@/lib/portal-status";
import Avatar from "@/components/Avatar";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useConfirm } from "@/components/ConfirmDialog";
import {
  addAccountAction,
  addPortalAction,
  bindIdentityAction,
  bindPendingIdentityAction,
  dismissPendingIdentityAction,
  editPortalSoftwareAction,
  ignorePendingIdentityAction,
  remapIdentityAction,
  removeAccountAction,
  removePortalAction,
  renameAccountAction,
  renamePortalAction,
  requestSyncAction,
  unbindIdentityAction,
} from "./actions";

// The Patient portals page (#1874): the OBJECT MODEL, rendered.
//
// Portal → login → patient is the page. Each portal is a permanent card-section from
// creation; logins render as titled sub-groups inside their portal only when there are
// two or more (a one-login portal IS its login — the implicit "Default login" concept
// never surfaces anywhere); patients live under their login as avatar-chip rows. The
// stage machine renders as a checklist above the sections — unrolled into the five-step
// guide on first visit, a compact strip once a run has reported, gone at steady state.
//
// EVERY action returns a typed outcome and this component renders it INLINE, near the
// acted-on row (aria-live) — never in a page-bottom status line. Nothing here reports
// success unconditionally: binding can legitimately refuse (an unknown login, a profile
// the caller may not write, a mapping that changed under a stale screen), and the
// refusal renders where the tap happened.
//
// AVATAR CHIPS ARE THE PICKER, both directions (#1874 point 5). A mapped row reads
// `label → ⟨face + name⟩`; a pending row's picker is the household's chips — tap the
// face, then one primary Map. NO preselection anywhere, including the manual pre-bind:
// a misfiled patient is the harm this surface exists to prevent, so the choice must be
// made, not merely left alone.
//
// PATIENT LABELS ARE NOT EDITABLE (#1874 point 13). The label is the portal's verbatim
// spelling and the join key every upload resolves against; an edited label would orphan
// the binding. The mapped row's ⋯ menu states this at the point of temptation.

export interface ProfileChoice {
  id: number;
  name: string;
  photoPath: string | null;
  photoVersion: number;
}

export interface PortalView {
  id: number;
  name: string;
  software: string | null;
}

export interface AccountView {
  id: number;
  portalId: number;
  name: string;
  implicit: boolean;
  hasReport: boolean;
  // The login row's last-run status, formatted server-side by the ONE pure formatter
  // (lib/portal-status.ts) so a failure message renders the same everywhere.
  status: { tone: PortalStatusTone; text: string };
  // The open sync request's line, formatted server-side by the shared formatter
  // (lib/sync-requests.ts) — the card, the Upcoming item and the digest quote one text.
  openRequestLine: string | null;
}

export interface IdentityView {
  id: number;
  accountId: number;
  patientLabel: string;
  profileId: number | null;
  ignored: boolean;
  // The portal REFUSES the download for this person (#1889) — a settled answer, not a
  // fault. Rendered once as a quiet note and never as a failure event: no Data → Review
  // badge, no notification, and the staleness/post-visit nags suppress for this identity
  // because asking someone to collect what the portal will not give is a pointless nag.
  declined: boolean;
  lastOkAt: string | null;
  lastFailedAt: string | null;
}

export interface PendingView {
  id: number;
  accountId: number;
  patientLabel: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  // Cross-login "same person" assist (#1874 point 6): the profile an IDENTICAL label is
  // already mapped to on another login, and where — suggest-only, never auto-applied.
  suggestion: { profileId: number; where: string } | null;
}

// The ONE place holding the software display labels (#1836): the enum values live in
// lib/portals.ts (SOFTWARE_VALUES); these are their user-facing names, as chips.
// "Something else" is the user-facing name for generic-ccd; "Not sure" stores nothing.
const SOFTWARE_OPTIONS: { value: string; label: string }[] = [
  { value: "mychart", label: "MyChart" },
  { value: "cerner", label: "Cerner" },
  { value: "ecw", label: "eClinicalWorks" },
  { value: "generic-ccd", label: "Something else" },
  { value: "", label: "Not sure" },
];

function softwareLabel(value: string | null): string | null {
  if (!value) return null;
  return SOFTWARE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}

function day(stamp: string): string {
  return stamp.slice(0, 10);
}

type ActionFn = (fd: FormData) => Promise<{ ok: boolean; error?: string }>;
type Note = { key: string; kind: "ok" | "error"; text: string };

// Inline, aria-live feedback beside the acted-on control (#1874 point 3). Every slot is
// rendered up front (an aria-live region must exist before its content changes to be
// announced); at most one note exists at a time, keyed to where the action happened.
function RowNote({ id, note }: { id: string; note: Note | null }) {
  const mine = note && note.key === id ? note : null;
  return (
    <span
      aria-live="polite"
      data-testid="row-note"
      className={
        mine
          ? mine.kind === "ok"
            ? "text-xs text-emerald-600 dark:text-emerald-400"
            : "text-xs text-rose-600 dark:text-rose-400"
          : "text-xs"
      }
    >
      {mine ? mine.text : ""}
    </span>
  );
}

// One household member as a pressable chip — face + name (#1874 point 5). A button, not
// a ProfileSwitcherChip: tapping it answers "who is this patient", it never navigates or
// switches the session's acting profile.
function ProfileChip({
  profile,
  pressed,
  onPress,
  disabled,
}: {
  profile: ProfileChoice;
  pressed: boolean;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onPress}
      disabled={disabled}
      data-testid="profile-chip"
      className={`inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-0.5 pr-2.5 text-sm transition ${
        pressed
          ? "border-brand-500 bg-brand-50 text-brand-800 ring-1 ring-brand-500 dark:bg-brand-500/15 dark:text-brand-200"
          : "border-black/10 bg-white/70 text-slate-700 hover:bg-slate-50 dark:border-white/10 dark:bg-ink-900/70 dark:text-slate-200 dark:hover:bg-ink-850"
      }`}
    >
      <Avatar
        profile={{
          id: profile.id,
          name: profile.name,
          photo_path: profile.photoPath,
          photo_version: profile.photoVersion,
        }}
        size="sm"
      />
      <span className="truncate" data-testid="profile-chip-name">
        {profile.name}
      </span>
    </button>
  );
}

// The read-only face of a mapping: the same chip shape, not pressable.
function StaticChip({ profile }: { profile: ProfileChoice }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-black/10 bg-white/70 py-0.5 pl-0.5 pr-2.5 text-sm text-slate-700 dark:border-white/10 dark:bg-ink-900/70 dark:text-slate-200">
      <Avatar
        profile={{
          id: profile.id,
          name: profile.name,
          photo_path: profile.photoPath,
          photo_version: profile.photoVersion,
        }}
        size="sm"
      />
      <span className="truncate" data-testid="profile-chip-name">
        {profile.name}
      </span>
    </span>
  );
}

// The household's chips as a picker, with nothing preselected unless the caller says so.
function ChipPicker({
  profiles,
  chosen,
  onChoose,
  disabled,
}: {
  profiles: ProfileChoice[];
  chosen: number | null;
  onChoose: (id: number) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="profile-picker"
    >
      {profiles.map((p) => (
        <ProfileChip
          key={p.id}
          profile={p}
          pressed={chosen === p.id}
          onPress={() => onChoose(p.id)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}

// Software as visible chips (#1874 point 8) — the add form's picker and the ⋯ menu's
// edit UI are the same control.
function SoftwareChips({
  chosen,
  onChoose,
  disabled,
}: {
  chosen: string;
  onChoose: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-1.5"
      data-testid="software-picker"
    >
      {SOFTWARE_OPTIONS.map((o) => (
        <button
          key={o.value || "unsure"}
          type="button"
          aria-pressed={chosen === o.value}
          onClick={() => onChoose(o.value)}
          disabled={disabled}
          data-testid={`software-chip-${o.value || "unsure"}`}
          className={`rounded-full border px-2.5 py-0.5 text-xs transition ${
            chosen === o.value
              ? "border-brand-500 bg-brand-50 text-brand-800 ring-1 ring-brand-500 dark:bg-brand-500/15 dark:text-brand-200"
              : "border-black/10 text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-850"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function PortalsSurface({
  stage,
  checklist,
  blurb,
  portals,
  accounts,
  identities,
  pending,
  profiles,
  writableProfiles,
  isAdmin,
  canAct,
}: {
  stage: PortalSetupStage;
  checklist: PortalChecklistItem[] | null;
  blurb: string;
  portals: PortalView[];
  accounts: AccountView[];
  identities: IdentityView[];
  pending: PendingView[];
  // Every profile this login can REACH — for rendering a binding's chip.
  profiles: ProfileChoice[];
  // The profiles this login may WRITE — the only ones a picker may offer, since binding
  // onto anything else is refused at the gate anyway.
  writableProfiles: ProfileChoice[];
  isAdmin: boolean;
  // Admin, or write access to at least one profile: the population that can raise sync
  // requests and clear pending prompts.
  canAct: boolean;
}) {
  // `busy` (not `pending`): a pending IDENTITY is a domain noun on this screen, so the
  // transition flag gets the unambiguous name.
  const [busy, start] = useTransition();
  const [note, setNote] = useState<Note | null>(null);
  const confirm = useConfirm();

  // Which row's ⋯ menu is open — single-valued; two open menus is a state a row list
  // should not be able to reach.
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  // Add portal: ONE affordance, an inline focused card (#1874 point 7). Forced open as
  // the guide's step 1 on first visit.
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addSoftware, setAddSoftware] = useState("");

  // In-place row edits (#1874 point 12). Each is single-valued.
  const [renamingPortal, setRenamingPortal] = useState<number | null>(null);
  const [editingSoftware, setEditingSoftware] = useState<number | null>(null);
  const [softwareDraft, setSoftwareDraft] = useState("");
  const [addingLogin, setAddingLogin] = useState<number | null>(null);
  const [renamingAccount, setRenamingAccount] = useState<number | null>(null);
  const [renameText, setRenameText] = useState("");
  const [loginName, setLoginName] = useState("");

  // Re-map via the mapped row's chip (#1836/#1874 point 12): which identity's picker is
  // open, and the draft choice (starts PRESSED on the current profile).
  const [remapping, setRemapping] = useState<number | null>(null);
  const [remapChoice, setRemapChoice] = useState<number | null>(null);

  // Which profile each pending row is about to be mapped onto. Per row — two reported
  // patients on one login are usually two different people. UNSET UNTIL CHOSEN (#1756):
  // Map stays dead until a human has actually said who this is.
  const [pendingChoice, setPendingChoice] = useState<Record<number, number>>(
    {}
  );
  // Pending rows whose assist pill was declined ("Someone else…") — full picker instead.
  const [assistDeclined, setAssistDeclined] = useState<Record<number, boolean>>(
    {}
  );

  // The manual pre-bind escape hatch, per login: open state + its label/choice drafts.
  const [prebindFor, setPrebindFor] = useState<number | null>(null);
  const [prebindLabel, setPrebindLabel] = useState("");
  const [prebindChoice, setPrebindChoice] = useState<number | null>(null);

  // Run a server action and render its typed outcome inline. `okKey` is where success
  // renders (the acted-on row's nearest SURVIVING container — a verb that removes its
  // row reports on the group); `errKey` defaults to it.
  const run = (
    fd: FormData,
    fn: ActionFn,
    okKey: string,
    okMsg: string,
    opts: { errKey?: string; after?: () => void } = {}
  ) => {
    setNote(null);
    start(async () => {
      const r = await fn(fd);
      if (r.ok) {
        setNote({ key: okKey, kind: "ok", text: okMsg });
        opts.after?.();
      } else {
        setNote({
          key: opts.errKey ?? okKey,
          kind: "error",
          text: r.error ?? "That didn't work.",
        });
      }
    });
  };

  const profileById = (id: number | null) =>
    profiles.find((p) => p.id === id) ?? null;
  const accountsOf = (portalId: number) =>
    accounts.filter((a) => a.portalId === portalId);
  const identitiesOf = (accountId: number) =>
    identities.filter((i) => i.accountId === accountId);
  const pendingOf = (accountId: number) =>
    pending.filter((p) => p.accountId === accountId);

  const canPick = writableProfiles.length > 0;
  const showGuide =
    isAdmin &&
    (stage === "no-portals" ||
      stage === "create-token" ||
      stage === "first-run");

  // ── Row renderers ──────────────────────────────────────────────────────────

  function mappedRow(i: IdentityView) {
    const bound = profileById(i.profileId);
    const writable =
      i.profileId !== null &&
      writableProfiles.some((w) => w.id === i.profileId);
    const rowKey = `identity-${i.id}`;
    const groupKey = `account-${i.accountId}`;
    return (
      <li
        key={`i-${i.id}`}
        data-testid="portal-patient-row"
        data-label={i.patientLabel}
        className="rounded-lg border border-black/5 p-2 dark:border-white/5"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
            {i.patientLabel}
          </span>
          <span aria-hidden="true" className="text-slate-400">
            →
          </span>
          {i.ignored ? (
            <span
              className="text-sm text-slate-500 dark:text-slate-400"
              data-testid="portal-identity-ignored"
            >
              not synced (ignored)
            </span>
          ) : writable && canPick ? (
            // Tapping the chip re-opens the picker with the current profile pressed
            // (#1874 point 12). Saving is ONE compare-and-swap — never
            // unmap-then-rebind, so there is no window where the label is unmapped.
            <button
              type="button"
              data-testid="patient-chip"
              aria-label={`Change profile for ${i.patientLabel}`}
              title="Change profile"
              onClick={() => {
                setRemapping(remapping === i.id ? null : i.id);
                setRemapChoice(i.profileId);
              }}
              className="inline-flex"
            >
              {bound ? (
                <StaticChip profile={bound} />
              ) : (
                <span className="text-sm text-slate-500">?</span>
              )}
            </button>
          ) : bound ? (
            <StaticChip profile={bound} />
          ) : null}
          <span className="min-w-0 flex-1" />
          {!i.ignored && i.declined && (
            // QUIET, ONCE, AND WITHOUT AN ACTION (#1889). The portal offers this proxy a
            // preview with no Download button; that is identical tomorrow and identical
            // next month, and nothing the person running the tool can do about it. So it
            // is stated calmly and it names no fix — a repeated failure event here is how
            // a badge stops being read.
            <span
              className="text-xs text-slate-500 dark:text-slate-400"
              data-testid="portal-identity-declined"
            >
              the portal doesn&rsquo;t offer downloads for this proxy &mdash;
              nothing to fix
            </span>
          )}
          {!i.ignored && (
            // Per-(login, patient) "Last checked" (#1874 point 4) — computed against
            // the profile this patient is BOUND to, never the active one. A quiet check
            // still counts; a failure never erases the last good one.
            <span
              className="text-xs text-slate-500 dark:text-slate-400"
              data-testid="portal-patient-status"
            >
              {i.lastOkAt
                ? `Last checked ${day(i.lastOkAt)}`
                : "Not checked yet"}
              {i.lastFailedAt ? ` · last failure ${day(i.lastFailedAt)}` : ""}
            </span>
          )}
          <RowNote id={rowKey} note={note} />
          {/* ⋯ trailing everything, on every row type (#1874 point 14). */}
          {(writable || (i.ignored && canAct)) && (
            <OverflowMenu
              label={`Actions for ${i.patientLabel}`}
              open={openMenu === rowKey}
              onOpenChange={(open) => setOpenMenu(open ? rowKey : null)}
            >
              {({ close }) =>
                i.ignored ? (
                  // AN IGNORED ROW IS UN-IGNORED, NOT DELETED: the action routes this
                  // to unignorePortalIdentity, scoped to ignored = 1, so it can never
                  // remove a live binding.
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
                        groupKey,
                        "No longer ignored — the next run offers this patient again."
                      );
                    }}
                  >
                    Stop ignoring
                  </button>
                ) : (
                  <>
                    {/* The verbatim-identity contract, stated at the point of
                        temptation (#1874 point 13): the label is the portal's spelling
                        and the join key every upload resolves against, so it is
                        deliberately not editable here. */}
                    <p className="px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">
                      The name is the portal&apos;s spelling — it can&apos;t be
                      edited here.
                    </p>
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
                        // The row id only: the action resolves which profile this
                        // binding points at server-side and gates on that (#1747).
                        const fd = new FormData();
                        fd.set("identity_id", String(i.id));
                        run(
                          fd,
                          unbindIdentityAction,
                          groupKey,
                          "Mapping removed."
                        );
                      }}
                    >
                      Unmap
                    </button>
                  </>
                )
              }
            </OverflowMenu>
          )}
        </div>
        {remapping === i.id && !i.ignored && (
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-black/5 pt-2 dark:border-white/5">
            <ChipPicker
              profiles={writableProfiles}
              chosen={remapChoice}
              onChoose={setRemapChoice}
              disabled={busy}
            />
            <button
              type="button"
              className="btn text-sm"
              data-testid="remap-save"
              disabled={
                busy || remapChoice === null || remapChoice === i.profileId
              }
              onClick={() => {
                if (remapChoice === null || i.profileId === null) return;
                const fd = new FormData();
                fd.set("identity_id", String(i.id));
                // The compare half of the swap: the profile this screen SHOWED. A row
                // that changed meanwhile is refused, not overwritten.
                fd.set("expected_profile_id", String(i.profileId));
                fd.set("profile_id", String(remapChoice));
                run(fd, remapIdentityAction, rowKey, "✓ Profile changed", {
                  after: () => setRemapping(null),
                });
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="btn-ghost text-sm"
              data-testid="remap-cancel"
              onClick={() => setRemapping(null)}
            >
              Cancel
            </button>
          </div>
        )}
      </li>
    );
  }

  function pendingRow(p: PendingView) {
    const rowKey = `pending-${p.id}`;
    const groupKey = `account-${p.accountId}`;
    const chosen = pendingChoice[p.id] ?? null;
    const suggested = p.suggestion && !assistDeclined[p.id];
    const suggestionProfile = p.suggestion
      ? profileById(p.suggestion.profileId)
      : null;
    const mapOnto = (profileId: number) => {
      // The label is NOT sent — the action reads it off the pending row, so what gets
      // bound is exactly what was reported, character for character.
      const fd = new FormData();
      fd.set("pending_id", String(p.id));
      fd.set("profile_id", String(profileId));
      run(fd, bindPendingIdentityAction, groupKey, "✓ Mapped", {
        errKey: rowKey,
      });
    };
    return (
      <li
        key={`p-${p.id}`}
        data-testid="pending-row"
        data-label={p.patientLabel}
        className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-slate-800 dark:text-slate-100">
            {p.patientLabel}
          </span>
          <span className="text-xs text-slate-500 dark:text-slate-400">
            first seen {day(p.firstSeenAt)} · last seen {day(p.lastSeenAt)}
            {p.seenCount > 1 ? ` · seen ${p.seenCount}×` : ""}
          </span>
          <span className="min-w-0 flex-1" />
          <RowNote id={rowKey} note={note} />
          {canAct && (
            // Maintenance verbs, not co-equal CTAs (#1874 point 5): Ignore and Not now
            // live in the ⋯, and the durable one is admin-only (#1875).
            <OverflowMenu
              label={`Actions for ${p.patientLabel}`}
              open={openMenu === rowKey}
              onOpenChange={(open) => setOpenMenu(open ? rowKey : null)}
            >
              {({ close }) => (
                <>
                  <button
                    type="button"
                    className={MENU_ITEM}
                    data-testid="pending-dismiss"
                    title="Clear this prompt — it returns if the tool reports the patient again"
                    onClick={() => {
                      close();
                      const fd = new FormData();
                      fd.set("pending_id", String(p.id));
                      run(
                        fd,
                        dismissPendingIdentityAction,
                        groupKey,
                        "Cleared for now."
                      );
                    }}
                  >
                    Not now
                  </button>
                  {isAdmin && (
                    <button
                      type="button"
                      className={MENU_ITEM_DANGER}
                      data-testid="pending-ignore"
                      title="Never sync this patient — they stay refused, and stop appearing here"
                      onClick={async () => {
                        close();
                        // Durable, so it confirms and the copy states the gate
                        // (#1875): only an admin can do this, or undo it.
                        const ok = await confirm({
                          title: `Ignore ${p.patientLabel}?`,
                          message:
                            "Never sync this patient: every future upload for them is refused, and they stop appearing here. This holds until an admin stops ignoring them.",
                          confirmLabel: "Ignore patient",
                          danger: true,
                        });
                        if (!ok) return;
                        const fd = new FormData();
                        fd.set("pending_id", String(p.id));
                        run(
                          fd,
                          ignorePendingIdentityAction,
                          groupKey,
                          "Patient ignored — their records will not be filed here."
                        );
                      }}
                    >
                      Ignore
                    </button>
                  )}
                </>
              )}
            </OverflowMenu>
          )}
        </div>
        {canPick &&
          (suggested && suggestionProfile ? (
            // The cross-login assist (#1874 point 6): a dashed suggestion pill, one-tap
            // Map, never auto-applied. "Someone else…" opens the full picker.
            <div
              className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed border-brand-500/50 p-2"
              data-testid="assist-pill"
            >
              <StaticChip profile={suggestionProfile} />
              <span className="text-xs text-slate-600 dark:text-slate-300">
                same name is mapped on {p.suggestion!.where}
              </span>
              <button
                type="button"
                className="btn text-sm"
                data-testid="assist-map"
                disabled={busy}
                onClick={() => mapOnto(p.suggestion!.profileId)}
              >
                Map
              </button>
              <button
                type="button"
                className="btn-ghost text-sm"
                data-testid="assist-someone-else"
                onClick={() =>
                  setAssistDeclined((prev) => ({ ...prev, [p.id]: true }))
                }
              >
                Someone else…
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {/* NO preselection: the choice must be made, not merely left alone. */}
              <ChipPicker
                profiles={writableProfiles}
                chosen={chosen}
                onChoose={(id) =>
                  setPendingChoice((prev) => ({ ...prev, [p.id]: id }))
                }
                disabled={busy}
              />
              {/* The one primary CTA of a pending row — a button, not a menu entry. */}
              <button
                type="button"
                className="btn shrink-0 text-sm"
                disabled={busy || chosen === null}
                data-testid="pending-map"
                onClick={() => chosen !== null && mapOnto(chosen)}
              >
                Map
              </button>
            </div>
          ))}
      </li>
    );
  }

  // The manual pre-bind, labelled as the escape hatch it is. Patients normally appear
  // by themselves after a run, spelled the way the portal spells them — a guess is
  // refused, not corrected.
  function prebind(account: AccountView) {
    if (!canPick) return null;
    const key = `prebind-${account.id}`;
    if (prebindFor !== account.id) {
      return (
        <button
          type="button"
          className="text-xs text-slate-500 hover:text-brand-700 dark:text-slate-400 dark:hover:text-brand-300"
          data-testid="prebind-toggle"
          onClick={() => {
            setPrebindFor(account.id);
            setPrebindLabel("");
            setPrebindChoice(null);
          }}
        >
          Pre-bind a patient by hand…
        </button>
      );
    }
    return (
      <div className="space-y-2 rounded-lg border border-black/5 p-2 dark:border-white/5">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Use this only to pre-bind a label you know exactly, spelled the way
          the portal spells it — a guess is refused, not corrected.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={prebindLabel}
            onChange={(e) => setPrebindLabel(e.target.value)}
            placeholder="Patient as the portal spells it"
            aria-label="Patient label"
            className="input"
            data-testid="bind-label"
          />
          <ChipPicker
            profiles={writableProfiles}
            chosen={prebindChoice}
            onChoose={setPrebindChoice}
            disabled={busy}
          />
          <button
            type="button"
            className="btn text-sm"
            disabled={busy || !prebindLabel.trim() || prebindChoice === null}
            data-testid="bind-add"
            onClick={() => {
              const fd = new FormData();
              fd.set("account_id", String(account.id));
              fd.set("patient_label", prebindLabel);
              fd.set("profile_id", String(prebindChoice));
              run(fd, bindIdentityAction, `account-${account.id}`, "✓ Mapped", {
                errKey: key,
                after: () => {
                  setPrebindFor(null);
                  setPrebindLabel("");
                },
              });
            }}
          >
            Map
          </button>
          <button
            type="button"
            className="btn-ghost text-sm"
            data-testid="prebind-cancel"
            onClick={() => setPrebindFor(null)}
          >
            Cancel
          </button>
          <RowNote id={key} note={note} />
        </div>
      </div>
    );
  }

  // One login's content: its status + Request sync row (in the sub-group header when
  // the portal has several logins, directly under the portal header when it is the only
  // one), then its patient rows.
  function accountBody(account: AccountView) {
    const rows = identitiesOf(account.id);
    const waiting = pendingOf(account.id);
    const groupKey = `account-${account.id}`;
    return (
      <div className="space-y-2">
        <ul className="space-y-1.5">
          {rows.filter((i) => !i.ignored).map((i) => mappedRow(i))}
          {waiting.map((p) => pendingRow(p))}
          {rows.filter((i) => i.ignored).map((i) => mappedRow(i))}
        </ul>
        {rows.length === 0 && waiting.length === 0 && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            No patients yet — a run reports who this login covers.
          </p>
        )}
        {prebind(account)}
        <RowNote id={groupKey} note={note} />
      </div>
    );
  }

  function accountStatusLine(account: AccountView) {
    return (
      <>
        <span
          className={
            account.status.tone === "attention"
              ? "text-xs text-amber-700 dark:text-amber-300"
              : "text-xs text-slate-500 dark:text-slate-400"
          }
          data-testid="login-status"
          data-tone={account.status.tone}
        >
          {account.status.text}
        </span>
        {account.openRequestLine ? (
          <span
            className="text-xs text-brand-700 dark:text-brand-300"
            data-testid="sync-request-open"
          >
            {account.openRequestLine}
          </span>
        ) : (
          canAct && (
            <button
              type="button"
              className="btn-ghost shrink-0 text-xs"
              disabled={busy}
              data-testid="sync-request-ask"
              title="Ask whoever runs the companion tool for this login to run it"
              onClick={() => {
                const fd = new FormData();
                fd.set("account_id", String(account.id));
                run(
                  fd,
                  requestSyncAction,
                  `account-${account.id}`,
                  "Sync requested."
                );
              }}
            >
              Request sync
            </button>
          )
        )}
      </>
    );
  }

  function loginMenu(account: AccountView, portal: PortalView) {
    if (!isAdmin) return null;
    const key = `account-menu-${account.id}`;
    return (
      <OverflowMenu
        label={`Actions for ${account.name}`}
        open={openMenu === key}
        onOpenChange={(open) => setOpenMenu(open ? key : null)}
      >
        {({ close }) => (
          <>
            <button
              type="button"
              className={MENU_ITEM}
              data-testid="account-rename"
              onClick={() => {
                setRenamingAccount(account.id);
                setRenameText(account.name);
                close();
              }}
            >
              Rename
            </button>
            <button
              type="button"
              className={MENU_ITEM_DANGER}
              data-testid="portal-account-remove"
              onClick={async () => {
                close();
                const ok = await confirm({
                  title: `Remove the login “${account.name}”?`,
                  message:
                    "Every patient mapped on this login is removed with it, and the tool can no longer name it.",
                  confirmLabel: "Remove login",
                  danger: true,
                });
                if (!ok) return;
                const fd = new FormData();
                fd.set("account_id", String(account.id));
                run(
                  fd,
                  removeAccountAction,
                  `portal-${portal.id}`,
                  "Login removed."
                );
              }}
            >
              Remove
            </button>
          </>
        )}
      </OverflowMenu>
    );
  }

  function accountRenameForm(account: AccountView) {
    if (renamingAccount !== account.id) return null;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={renameText}
          onChange={(e) => setRenameText(e.target.value)}
          aria-label={`New name for ${account.name}`}
          className="input"
          data-testid="account-rename-input"
        />
        <button
          type="button"
          className="btn text-sm"
          disabled={busy || !renameText.trim()}
          data-testid="account-rename-save"
          onClick={() => {
            const fd = new FormData();
            fd.set("account_id", String(account.id));
            fd.set("name", renameText);
            run(fd, renameAccountAction, `account-${account.id}`, "✓ Renamed", {
              after: () => setRenamingAccount(null),
            });
          }}
        >
          Save
        </button>
        <button
          type="button"
          className="btn-ghost text-sm"
          data-testid="account-rename-cancel"
          onClick={() => setRenamingAccount(null)}
        >
          Cancel
        </button>
      </div>
    );
  }

  function portalSection(portal: PortalView) {
    const portalAccounts = accountsOf(portal.id);
    const multi = portalAccounts.length > 1;
    const sectionKey = `portal-${portal.id}`;
    const tag = softwareLabel(portal.software);
    // Nothing has ever happened on this portal: no run, no patients, nothing pending.
    // Creation has a visible result — this section — and it names the next PHYSICAL
    // step instead of jumping scenes (#1874 point 7).
    const waitingFirstRun =
      portalAccounts.every((a) => !a.hasReport) &&
      portalAccounts.every(
        (a) => identitiesOf(a.id).length === 0 && pendingOf(a.id).length === 0
      );
    return (
      <section
        key={portal.id}
        className="card space-y-3"
        data-testid="portal-section"
        data-portal-name={portal.name}
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            {portal.name}
          </h2>
          {tag && (
            <span
              className="rounded-full border border-black/10 px-2 py-0.5 text-xs text-slate-500 dark:border-white/10 dark:text-slate-400"
              data-testid="portal-software-tag"
            >
              {tag}
            </span>
          )}
          <span className="min-w-0 flex-1" />
          <RowNote id={sectionKey} note={note} />
          {isAdmin && (
            <OverflowMenu
              label={`Actions for ${portal.name}`}
              open={openMenu === sectionKey}
              onOpenChange={(open) => setOpenMenu(open ? sectionKey : null)}
            >
              {({ close }) => (
                <>
                  <button
                    type="button"
                    className={MENU_ITEM}
                    data-testid="portal-rename"
                    onClick={() => {
                      setRenamingPortal(portal.id);
                      setRenameText(portal.name);
                      close();
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    className={MENU_ITEM}
                    data-testid="portal-software-edit"
                    onClick={() => {
                      setEditingSoftware(portal.id);
                      setSoftwareDraft(portal.software ?? "");
                      close();
                    }}
                  >
                    Edit software
                  </button>
                  <button
                    type="button"
                    className={MENU_ITEM}
                    data-testid="portal-add-login"
                    onClick={() => {
                      setAddingLogin(portal.id);
                      setLoginName("");
                      close();
                    }}
                  >
                    Add a login
                  </button>
                  <button
                    type="button"
                    className={MENU_ITEM_DANGER}
                    data-testid="portal-remove"
                    onClick={async () => {
                      close();
                      const ok = await confirm({
                        title: `Remove ${portal.name}?`,
                        message:
                          "Its logins and every patient mapped on it go too. Documents already imported stay, but they stop naming the portal they came from.",
                        confirmLabel: "Remove portal",
                        danger: true,
                      });
                      if (!ok) return;
                      const fd = new FormData();
                      fd.set("portal_id", String(portal.id));
                      run(fd, removePortalAction, "portals", "Portal removed.");
                    }}
                  >
                    Remove
                  </button>
                </>
              )}
            </OverflowMenu>
          )}
        </div>

        {renamingPortal === portal.id && (
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={renameText}
              onChange={(e) => setRenameText(e.target.value)}
              aria-label={`New name for ${portal.name}`}
              className="input"
              data-testid="portal-rename-input"
            />
            <button
              type="button"
              className="btn text-sm"
              disabled={busy || !renameText.trim()}
              data-testid="portal-rename-save"
              onClick={() => {
                const fd = new FormData();
                fd.set("portal_id", String(portal.id));
                fd.set("name", renameText);
                run(fd, renamePortalAction, sectionKey, "✓ Renamed", {
                  after: () => setRenamingPortal(null),
                });
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="btn-ghost text-sm"
              data-testid="portal-rename-cancel"
              onClick={() => setRenamingPortal(null)}
            >
              Cancel
            </button>
          </div>
        )}

        {editingSoftware === portal.id && (
          <div className="flex flex-wrap items-center gap-2">
            <SoftwareChips
              chosen={softwareDraft}
              onChoose={setSoftwareDraft}
              disabled={busy}
            />
            <button
              type="button"
              className="btn text-sm"
              disabled={busy}
              data-testid="portal-software-save"
              onClick={() => {
                const fd = new FormData();
                fd.set("portal_id", String(portal.id));
                fd.set("software", softwareDraft);
                run(fd, editPortalSoftwareAction, sectionKey, "✓ Saved", {
                  after: () => setEditingSoftware(null),
                });
              }}
            >
              Save
            </button>
            <button
              type="button"
              className="btn-ghost text-sm"
              data-testid="portal-software-cancel"
              onClick={() => setEditingSoftware(null)}
            >
              Cancel
            </button>
          </div>
        )}

        {addingLogin === portal.id && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Add a login only when two people sign in to this portal with their
              own accounts. A nickname or the account&apos;s email address is
              all allos keeps — never a password, and never the web address you
              sign in at.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={loginName}
                onChange={(e) => setLoginName(e.target.value)}
                placeholder="“Mom”, “dad@example.com”"
                aria-label="Login nickname"
                className="input"
                data-testid="account-name"
              />
              <button
                type="button"
                className="btn text-sm"
                disabled={busy || !loginName.trim()}
                data-testid="account-add"
                onClick={() => {
                  const fd = new FormData();
                  fd.set("portal_id", String(portal.id));
                  fd.set("name", loginName);
                  run(fd, addAccountAction, sectionKey, "✓ Added", {
                    after: () => setAddingLogin(null),
                  });
                }}
              >
                Add login
              </button>
              <button
                type="button"
                className="btn-ghost text-sm"
                data-testid="account-add-cancel"
                onClick={() => setAddingLogin(null)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {waitingFirstRun ? (
          <p
            className="text-sm text-slate-600 dark:text-slate-300"
            data-testid="portal-waiting"
          >
            Waiting for its first run — start the companion tool on the computer
            that signs in to {portal.name}. It reports which patients that login
            covers, and they appear here to be mapped. The first run fetches
            your full history and can take several minutes.
          </p>
        ) : null}

        {multi ? (
          // Logins as titled sub-groups, ONLY when there are two or more (#1874 point
          // 2): a one-login portal IS its login, and "Default login" never surfaces.
          <div className="space-y-3">
            {portalAccounts.map((a) => (
              <div
                key={a.id}
                className="space-y-2 rounded-lg border border-black/10 p-3 dark:border-white/10"
                data-testid="portal-login-group"
                data-login-name={a.name}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {a.name}
                  </h3>
                  <span className="min-w-0 flex-1" />
                  {accountStatusLine(a)}
                  {loginMenu(a, portal)}
                </div>
                {accountRenameForm(a)}
                {accountBody(a)}
              </div>
            ))}
          </div>
        ) : portalAccounts.length === 1 ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="min-w-0 flex-1" />
              {accountStatusLine(portalAccounts[0])}
            </div>
            {accountBody(portalAccounts[0])}
          </div>
        ) : null}
      </section>
    );
  }

  // ── Add portal: one inline focused card (#1874 point 7) ────────────────────

  function addPortalForm(context: "card" | "guide") {
    return (
      <div className="space-y-3" data-testid="portal-add-form">
        <div>
          <input
            value={addName}
            onChange={(e) => setAddName(e.target.value)}
            placeholder="Ochsner MyChart"
            aria-label="Portal name"
            className="input w-full"
            data-testid="portal-name"
          />
          {/* The privacy promise lives with the field it is about (#1874 point 8). */}
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Name it the way your household says it. The web address stays in the
            companion tool on your own computer — it&apos;s never stored here.
          </p>
        </div>
        <div className="space-y-1">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Which software does it run?
          </p>
          <SoftwareChips
            chosen={addSoftware}
            onChoose={setAddSoftware}
            disabled={busy}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn"
            disabled={busy || !addName.trim()}
            data-testid="portal-add"
            onClick={() => {
              const fd = new FormData();
              fd.set("name", addName);
              fd.set("software", addSoftware);
              run(fd, addPortalAction, "portals", "✓ Portal added", {
                errKey: "add-portal",
                after: () => {
                  setAddName("");
                  setAddSoftware("");
                  setAddOpen(false);
                },
              });
            }}
          >
            Add portal
          </button>
          {context === "card" && (
            <button
              type="button"
              className="btn-ghost"
              data-testid="portal-add-cancel"
              onClick={() => setAddOpen(false)}
            >
              Cancel
            </button>
          )}
          <RowNote id="add-portal" note={note} />
        </div>
      </div>
    );
  }

  function addPortalCard() {
    if (!isAdmin) return null;
    return (
      <section className="card space-y-3" data-testid="portal-add-card">
        {addOpen ? (
          <>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">
              Add a portal
            </h2>
            {addPortalForm("card")}
          </>
        ) : (
          <button
            type="button"
            className="text-left text-sm font-medium text-brand-700 hover:underline dark:text-brand-300"
            data-testid="portal-add-toggle"
            onClick={() => setAddOpen(true)}
          >
            ＋ Add a portal
          </button>
        )}
        {/* Add/remove outcomes land here — beside the affordance, never a page-bottom
            line. A successful add is ALSO visible as the section that materialized
            above, in place (#1874 point 7). */}
        {!addOpen && <RowNote id="portals" note={note} />}
      </section>
    );
  }

  // ── The first-visit guide (#1874 point 9) ──────────────────────────────────
  //
  // The checklist, unrolled into one vertical five-step guide. Step 1 IS the
  // add-portal form; completing it materializes the portal section ABOVE this guide,
  // flips step 1 to ✓ and lights step 2 — progression, not a scene change. The guide
  // renders until the first run reports; from then on the compact strip carries the
  // remaining steps.

  function guideStep(
    n: number,
    title: string,
    state: "done" | "current" | "todo",
    body: ReactNode
  ) {
    return (
      <li
        className="flex gap-3"
        data-testid={`guide-step-${n}`}
        data-state={state}
      >
        <span
          aria-hidden="true"
          className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
            state === "done"
              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
              : state === "current"
                ? "bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300"
                : "bg-slate-100 text-slate-500 dark:bg-ink-800 dark:text-slate-400"
          }`}
        >
          {state === "done" ? "✓" : n}
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <p
            className={`text-sm font-medium ${
              state === "todo"
                ? "text-slate-500 dark:text-slate-400"
                : "text-slate-800 dark:text-slate-100"
            }`}
          >
            {title}
          </p>
          {body}
        </div>
      </li>
    );
  }

  function guide() {
    const done = new Map(
      (checklist ?? []).map((c) => [c.key, c.done] as const)
    );
    const portalDone = done.get("portal") ?? false;
    const tokenDone = done.get("token") ?? false;
    const stepState = (
      isDone: boolean,
      isCurrent: boolean
    ): "done" | "current" | "todo" =>
      isDone ? "done" : isCurrent ? "current" : "todo";
    return (
      <section className="card space-y-4" data-testid="portal-guide">
        <div>
          <h2 className="font-semibold text-slate-800 dark:text-slate-100">
            Bring in records from a portal
          </h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            {blurb}
          </p>
        </div>
        <ol className="space-y-4">
          {guideStep(
            1,
            "Add the portal you use",
            stepState(portalDone, stage === "no-portals"),
            stage === "no-portals" ? (
              addPortalForm("guide")
            ) : (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {portals.length === 1
                  ? `${portals[0].name} is set up above.`
                  : "Your portals are set up above."}
              </p>
            )
          )}
          {guideStep(
            2,
            "Create an API token for the computer that will run the tool",
            stepState(tokenDone, stage === "create-token"),
            <p className="text-xs text-slate-500 dark:text-slate-400">
              The companion tool needs one to push documents in. Create it under{" "}
              <Link
                href="/settings/tokens"
                className="text-brand-700 hover:underline dark:text-brand-300"
                data-testid="guide-token-link"
              >
                Settings → API tokens
              </Link>{" "}
              with the <strong>Upload documents</strong> capability, named for
              the device — “Mom’s laptop” — so retiring a machine never disturbs
              the others.
            </p>
          )}
          {guideStep(
            3,
            "Run the companion tool on that computer",
            stepState(false, stage === "first-run"),
            <p className="text-xs text-slate-500 dark:text-slate-400">
              <a
                href="https://github.com/FloorLamp/allos"
                target="_blank"
                rel="noreferrer"
                className="text-brand-700 hover:underline dark:text-brand-300"
                data-testid="guide-tool-link"
              >
                Get the companion tool
              </a>{" "}
              and start it on the computer that signs in to the portal. It signs
              in the way you would — you type the two-factor code — and reports
              which patients that login covers. The first run fetches your full
              history and can take several minutes.
            </p>
          )}
          {guideStep(
            4,
            "Map each reported patient to a profile, once",
            "todo",
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Patients appear here spelled exactly as the portal spells them —
              you never predict a name. Anything unmapped is refused rather than
              filed under a guess.
            </p>
          )}
          {guideStep(
            5,
            "Documents land in Data → Review",
            "todo",
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Same as any other import — with the same review, deduplication and
              checks. See{" "}
              <Link
                href="/data?section=review"
                className="text-brand-700 hover:underline dark:text-brand-300"
              >
                Data → Review
              </Link>
              .
            </p>
          )}
        </ol>
      </section>
    );
  }

  // ── The compact checklist strip (#1874 point 1) ────────────────────────────

  function checklistStrip() {
    if (!checklist) return null;
    return (
      <div
        className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
        data-testid="portal-checklist"
      >
        {checklist.map((item, idx) => (
          <span key={item.key} className="inline-flex items-center gap-2">
            {idx > 0 && (
              <span
                aria-hidden="true"
                className="text-slate-300 dark:text-slate-600"
              >
                ·
              </span>
            )}
            <span
              data-testid={`checklist-${item.key}`}
              data-done={item.done ? "true" : "false"}
              className={
                item.done
                  ? "text-emerald-600 dark:text-emerald-400"
                  : item.current
                    ? "font-medium text-amber-700 dark:text-amber-300"
                    : "text-slate-500 dark:text-slate-400"
              }
            >
              {item.done ? "✓ " : ""}
              {item.label}
            </span>
          </span>
        ))}
      </div>
    );
  }

  // ── The page ───────────────────────────────────────────────────────────────

  const memberNames = profiles.map((p) => p.name).join(", ");

  return (
    <div className="space-y-6">
      {/* Scope, stated ONCE (#1874 point 4). Nothing on this page follows the active
          profile; per-patient "Last checked" lives on the patient rows. */}
      {portals.length > 0 && (
        <p
          className="text-sm text-slate-500 dark:text-slate-400"
          data-testid="portals-scope-note"
        >
          {isAdmin
            ? "One place for the whole household — every portal, login and patient mapping lives here."
            : `You're seeing the logins that cover ${memberNames}.`}
        </p>
      )}

      {/* The strip needs structure to sit above: a member with no covering login gets
          the promise below, never a checklist for steps they cannot take. */}
      {portals.length > 0 && !showGuide && checklistStrip()}

      {portals.map((p) => portalSection(p))}

      {/* The one add affordance. During the first-visit guide the form IS step 1, so
          the card would be the same field twice — it appears once step 1 is done. */}
      {isAdmin && stage !== "no-portals" && addPortalCard()}

      {showGuide && guide()}

      {/* Member × empty is a promise, not a dead end (#1874 point 10). */}
      {!isAdmin && portals.length === 0 && (
        <section className="card" data-testid="portals-member-empty">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            No portals yet — an admin on this instance can add one. Once a
            portal login covering {memberNames} reports its patients, they’ll
            appear here for you to map.
          </p>
        </section>
      )}
    </div>
  );
}
