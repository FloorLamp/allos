"use client";

import { useState, useTransition } from "react";
import Avatar from "@/components/Avatar";
import PhotoPicker from "@/components/PhotoPicker";
import { useConfirm } from "@/components/ConfirmDialog";
import { NOTICE_TONE } from "@/components/Notice";
import { membersLosingAllAccess } from "@/lib/family-deletion";
import { grantCountSummary, type Access } from "@/lib/grants";
import {
  defaultAccessSelection,
  deletionErasesText,
  grantFormEntries,
  initialGrantSelection,
  isDuplicateProfileName,
  loadedGrantSignature,
  memberGrantList,
  profileChoiceLabels,
  setGrantLevel,
  toggleGrant,
} from "@/lib/family-ui";
import { uploadProfilePhoto, removeProfilePhoto } from "../photo-actions";
import type { ProfileDataSummary } from "./page";
import {
  createProfile,
  renameProfile,
  deleteProfile,
  createLogin,
  resetPassword,
  deleteLogin,
  revokeLoginSessions,
  setGrants,
  setLoginOwnProfile,
  setLoginEmail,
  sendInvite,
  type FamilyResult,
} from "./actions";

interface Profile {
  id: number;
  name: string;
  photo_path: string | null;
  photo_version: number;
}
interface Login {
  id: number;
  username: string;
  role: "admin" | "member";
  email: string | null;
  // The login's own-profile association (issue #1013), or null — which profile the
  // login considers "mine". Admin-editable here; constrained to the login's
  // accessible profiles server-side.
  own_profile_id: number | null;
}

// A small inline status line shared by every form in this screen.
function Msg({ result }: { result: FamilyResult | null }) {
  if (!result) return null;
  return (
    <p
      className={`text-sm ${
        result.ok
          ? "text-emerald-600 dark:text-emerald-400"
          : "text-rose-600 dark:text-rose-400"
      }`}
    >
      {result.ok ? (result.message ?? "Saved.") : result.error}
    </p>
  );
}

export default function FamilyManager({
  profiles,
  logins,
  grants,
  access,
  summaries,
  sessionCounts,
  canInvite,
}: {
  profiles: Profile[];
  logins: Login[];
  grants: Record<number, number[]>;
  access: Record<number, Record<number, Access>>;
  summaries: Record<number, ProfileDataSummary>;
  sessionCounts: Record<number, number>;
  // Whether the instance can send login-lifecycle mail (SMTP + public URL set).
  // Gates the invite affordances; false hides them (Settings → Server sets it up).
  canInvite: boolean;
}) {
  return (
    <div className="max-w-3xl space-y-6">
      <ProfilesCard
        profiles={profiles}
        logins={logins}
        grants={grants}
        summaries={summaries}
      />
      <LoginsCard
        logins={logins}
        profiles={profiles}
        grants={grants}
        sessionCounts={sessionCounts}
        canInvite={canInvite}
      />
      <GrantsCard
        logins={logins}
        profiles={profiles}
        grants={grants}
        access={access}
      />
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Deleting a profile permanently erases that person&apos;s entire health
        record and cannot be undone. Deleting a login removes the login only —
        the profiles it could access are kept.
      </p>
    </div>
  );
}

// ---- Profiles ----

function ProfilesCard({
  profiles,
  logins,
  grants,
  summaries,
}: {
  profiles: Profile[];
  logins: Login[];
  grants: Record<number, number[]>;
  summaries: Record<number, ProfileDataSummary>;
}) {
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FamilyResult | null>(null);
  const [newName, setNewName] = useState("");
  const members = memberGrantList(logins, grants);

  async function add() {
    // Profile names aren't unique-constrained, so an accidental double-submit used
    // to create two identical profiles silently (issue #1434). Soft confirm — a
    // deliberate second "Jordan" is still allowed, it just can't happen by mistake.
    if (isDuplicateProfileName(newName, profiles)) {
      const ok = await confirm({
        title: `You already have a profile named “${newName.trim()}”`,
        message:
          "Two profiles with the same name are told apart only by a “(2)” label. Create another one anyway?",
        confirmLabel: "Create another",
      });
      if (!ok) return;
    }
    const fd = new FormData();
    fd.set("name", newName);
    start(async () => {
      const r = await createProfile(fd);
      setResult(r);
      if (r.ok) {
        setNewName("");
      }
    });
  }

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Profiles
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          The people you track. Adding a family member (e.g. a kid) is just a
          name — they don&apos;t need their own login unless you want to give
          them one below.
        </p>
      </div>

      <div className="space-y-2">
        {profiles.map((p) => (
          <ProfileRow
            key={p.id}
            profile={p}
            summary={summaries[p.id]}
            losingAccess={membersLosingAllAccess(p.id, members)}
            canDelete={profiles.length > 1}
          />
        ))}
      </div>

      <div className="border-t border-black/10 pt-4 dark:border-white/10">
        <label className="label" htmlFor="family-new-profile-name">
          Add a profile
        </label>
        <div className="flex items-end gap-2">
          <input
            id="family-new-profile-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Name"
            className="input"
          />
          <button
            type="button"
            onClick={add}
            disabled={pending || !newName.trim()}
            className="btn shrink-0"
          >
            Add
          </button>
        </div>
        <div className="mt-2">
          <Msg result={result} />
        </div>
      </div>
    </div>
  );
}

function ProfileRow({
  profile,
  summary,
  losingAccess,
  canDelete,
}: {
  profile: Profile;
  summary: ProfileDataSummary | undefined;
  losingAccess: string[];
  canDelete: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FamilyResult | null>(null);
  const [name, setName] = useState(profile.name);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [typedName, setTypedName] = useState("");
  // A photo upload/remove runs on its own transition inside PhotoPicker; mirror
  // its busy state so rename/delete can't run concurrently with it (a delete
  // racing an in-flight upload would leave an orphaned photo file on disk).
  const [photoBusy, setPhotoBusy] = useState(false);
  const busy = pending || photoBusy;

  function del() {
    if (typedName.trim() !== profile.name) return;
    const fd = new FormData();
    fd.set("id", String(profile.id));
    start(async () => {
      const r = await deleteProfile(fd);
      setResult(r);
      if (r.ok) {
        setConfirmOpen(false);
        setTypedName("");
      }
    });
  }

  function save() {
    const fd = new FormData();
    fd.set("id", String(profile.id));
    fd.set("name", name);
    start(async () => {
      const r = await renameProfile(fd);
      setResult(r);
    });
  }

  const dirty = name.trim() !== profile.name && name.trim() !== "";
  return (
    <div className="flex items-start gap-3 rounded-lg border border-black/10 p-3 dark:border-white/10">
      <Avatar profile={profile} size="md" className="mt-0.5" />
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="input"
          />
          <button
            type="button"
            onClick={save}
            disabled={busy || !dirty}
            className="btn-ghost shrink-0"
          >
            Rename
          </button>
        </div>
        <PhotoPicker
          hasPhoto={!!profile.photo_path}
          variant="compact"
          disabled={pending}
          onBusyChange={setPhotoBusy}
          onUpload={(file) => {
            const fd = new FormData();
            fd.set("profileId", String(profile.id));
            fd.set("file", file);
            return uploadProfilePhoto(fd);
          }}
          onRemove={() => {
            const fd = new FormData();
            fd.set("profileId", String(profile.id));
            return removeProfilePhoto(fd);
          }}
        />
        <div className="flex items-center gap-3">
          {!confirmOpen && (
            <button
              type="button"
              onClick={() => {
                setResult(null);
                setConfirmOpen(true);
              }}
              disabled={busy || !canDelete}
              title={
                canDelete
                  ? undefined
                  : "The only profile can't be deleted — at least one must remain."
              }
              className="text-xs font-medium text-rose-600 hover:underline disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline dark:text-rose-400 dark:disabled:text-slate-500"
            >
              Delete profile
            </button>
          )}
        </div>

        {confirmOpen && (
          <div
            className={`space-y-3 rounded-lg border p-3 ${NOTICE_TONE.rose}`}
          >
            <p className="text-sm font-semibold text-rose-700 dark:text-rose-300">
              Permanently delete “{profile.name}” and all of their data?
            </p>
            <p className="text-xs text-rose-700/90 dark:text-rose-300/90">
              This erases {deletionErasesText(summary)} — plus goals,
              supplements, equipment, and any imported metrics. This cannot be
              undone.
            </p>
            {losingAccess.length > 0 && (
              <p className="text-xs text-rose-700/90 dark:text-rose-300/90">
                {losingAccess.join(", ")}{" "}
                {losingAccess.length === 1 ? "will" : "will each"} lose access
                to the app until granted another profile.
              </p>
            )}
            <div>
              <label className="label text-rose-700 dark:text-rose-300">
                Type “{profile.name}” to confirm
              </label>
              <input
                value={typedName}
                onChange={(e) => setTypedName(e.target.value)}
                autoComplete="off"
                className="input"
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={del}
                disabled={busy || typedName.trim() !== profile.name}
                className="btn-danger shrink-0"
              >
                Delete permanently
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmOpen(false);
                  setTypedName("");
                }}
                disabled={pending}
                className="btn-ghost shrink-0"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        <Msg result={result} />
      </div>
    </div>
  );
}

// ---- Logins ----

function LoginsCard({
  logins,
  profiles,
  grants,
  sessionCounts,
  canInvite,
}: {
  logins: Login[];
  profiles: Profile[];
  grants: Record<number, number[]>;
  sessionCounts: Record<number, number>;
  canInvite: boolean;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FamilyResult | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const [invite, setInvite] = useState(false);
  // Initial profile access for the member being created (issue #1434). Kept as an
  // explicit "the admin touched this" flag so the same-named-profile default can
  // keep tracking the username as it's typed, but never fights a deliberate choice.
  const [accessTouched, setAccessTouched] = useState(false);
  const [accessIds, setAccessIds] = useState<number[]>([]);
  const adminCount = logins.filter((a) => a.role === "admin").length;
  const choices = profileChoiceLabels(profiles);
  const defaulted = defaultAccessSelection(username, profiles);
  const selectedAccess = accessTouched ? accessIds : defaulted;
  // Passwordless when the invite carries the credential (issue #1434 part C): the
  // checkbox's own copy says "instead of setting a password", so the field is
  // disabled and the create no longer demands one.
  const invitePath = canInvite && invite && !!email.trim();

  function toggleAccess(id: number) {
    setAccessIds(
      selectedAccess.includes(id)
        ? selectedAccess.filter((x) => x !== id)
        : [...selectedAccess, id]
    );
    setAccessTouched(true);
  }

  function create() {
    const fd = new FormData();
    fd.set("username", username);
    if (!invitePath) fd.set("password", password);
    fd.set("role", role);
    fd.set("email", email);
    if (invite) fd.set("invite", "1");
    // Same field shape as the grants matrix; the action re-validates every id and
    // ignores the selection entirely for an admin (implicit all-profile access).
    if (role === "member") {
      for (const id of selectedAccess) {
        fd.append("profileId", String(id));
        fd.set(`access_${id}`, "write");
      }
    }
    start(async () => {
      const r = await createLogin(fd);
      setResult(r);
      if (r.ok) {
        setUsername("");
        setPassword("");
        setEmail("");
        setRole("member");
        setInvite(false);
        setAccessIds([]);
        setAccessTouched(false);
      }
    });
  }

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Logins
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Logins. Admins can access every profile and this screen; members see
          only the profiles you grant them below.
        </p>
      </div>

      <div className="space-y-2">
        {logins.map((a) => (
          <LoginRow
            key={a.id}
            login={a}
            isLastAdmin={a.role === "admin" && adminCount <= 1}
            sessionCount={sessionCounts[a.id] ?? 0}
            grantCount={(grants[a.id] ?? []).length}
            canInvite={canInvite}
          />
        ))}
      </div>

      <div className="space-y-3 border-t border-black/10 pt-4 dark:border-white/10">
        <label className="label" htmlFor="family-new-login-username">
          Add a login
        </label>
        <div className="grid gap-2 sm:grid-cols-3">
          <input
            id="family-new-login-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoComplete="off"
            aria-label="Username"
            className="input"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={invitePath ? "Set by invite" : "Password"}
            type="password"
            autoComplete="new-password"
            disabled={invitePath}
            aria-label="Password"
            data-testid="create-password"
            className="input disabled:opacity-40"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "member")}
            data-testid="create-role"
            aria-label="Role"
            className="input"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email (optional)"
            type="email"
            autoComplete="off"
            aria-label="Email"
            className="input sm:col-span-3"
          />
        </div>
        {canInvite && (
          <label className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            <input
              type="checkbox"
              checked={invite}
              onChange={(e) => setInvite(e.target.checked)}
              disabled={!email.trim()}
              data-testid="create-invite"
              className="h-4 w-4 accent-brand-600 disabled:opacity-40"
            />
            Email an invite instead of setting a password out-of-band
          </label>
        )}
        {/* Initial profile access (issue #1434): a member created with no grants
            authenticates and then lands nowhere, so access is part of creating one.
            Labels are disambiguated (#534) — two same-named profiles must never
            render as identical rows in the place where picking the wrong one
            matters most. Admins reach every profile, so the picker hides for them. */}
        {role === "member" && (
          <div data-testid="create-access" className="space-y-1">
            <p className="label mb-0">Profile access</p>
            {profiles.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Add a profile first — a member with no profile access can&apos;t
                use the app.
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {choices.map((c) => (
                    <label
                      key={c.id}
                      className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200"
                    >
                      <input
                        type="checkbox"
                        checked={selectedAccess.includes(c.id)}
                        onChange={() => toggleAccess(c.id)}
                        data-testid={`create-access-${c.id}`}
                        className="h-4 w-4 accent-brand-600"
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
                {selectedAccess.length === 0 && (
                  <p
                    data-testid="create-access-warning"
                    className="text-xs text-amber-700 dark:text-amber-400"
                  >
                    With no profile selected this login can sign in but has
                    nowhere to land — you can grant access later under Access.
                  </p>
                )}
              </>
            )}
          </div>
        )}
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={create}
            disabled={pending || !username.trim() || (!invitePath && !password)}
            className="btn"
          >
            Create login
          </button>
          <Msg result={result} />
        </div>
      </div>
    </div>
  );
}

function LoginRow({
  login,
  isLastAdmin,
  sessionCount,
  grantCount,
  canInvite,
}: {
  login: Login;
  isLastAdmin: boolean;
  sessionCount: number;
  // How many profiles this login is granted. Zero on a MEMBER is the dead-end
  // (issue #1434): the login authenticates and then has nowhere to land, so the
  // row says so instead of leaving the admin with no signal at all.
  grantCount: number;
  canInvite: boolean;
}) {
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FamilyResult | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [emailOpen, setEmailOpen] = useState(false);
  const [email, setEmail] = useState(login.email ?? "");

  function reset() {
    const fd = new FormData();
    fd.set("id", String(login.id));
    fd.set("password", password);
    start(async () => {
      const r = await resetPassword(fd);
      setResult(r);
      if (r.ok) {
        setPassword("");
        setOpen(false);
      }
    });
  }

  function saveEmail() {
    const fd = new FormData();
    fd.set("id", String(login.id));
    fd.set("email", email);
    start(async () => {
      const r = await setLoginEmail(fd);
      setResult(r);
      if (r.ok) setEmailOpen(false);
    });
  }

  function invite() {
    const fd = new FormData();
    fd.set("id", String(login.id));
    start(async () => {
      const r = await sendInvite(fd);
      setResult(r);
    });
  }

  async function revokeSessions() {
    setResult(null);
    const ok = await confirm({
      title: `Sign out all devices for “${login.username}”?`,
      message: (
        <>
          Every device currently signed in as <strong>{login.username}</strong>{" "}
          will be logged out. The password is unchanged — they can sign in again
          with it.
        </>
      ),
      confirmLabel: "Sign out all devices",
      danger: true,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("id", String(login.id));
    start(async () => {
      const r = await revokeLoginSessions(fd);
      setResult(r);
    });
  }

  async function del() {
    setResult(null);
    const ok = await confirm({
      title: `Delete login “${login.username}”?`,
      message: (
        <>
          This removes the login and signs out its active sessions. The profiles
          it could access are <strong>not</strong> deleted. If this is your own
          login, you’ll be signed out.
        </>
      ),
      confirmLabel: "Delete login",
      danger: true,
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("id", String(login.id));
    start(async () => {
      const r = await deleteLogin(fd);
      setResult(r);
    });
  }

  return (
    <div
      data-testid="login-row"
      className="rounded-lg border border-black/10 p-3 dark:border-white/10"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-800 dark:text-slate-100">
            {login.username}
          </span>
          <span
            className={`badge ${
              login.role === "admin"
                ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
                : "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
            }`}
          >
            {login.role}
          </span>
          {login.role === "member" && grantCount === 0 && (
            <span
              data-testid="login-no-access"
              title="This login has no profile access — it can sign in but has nowhere to land. Grant it a profile under Access."
              className="badge bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300"
            >
              no access
            </span>
          )}
          <span className="text-xs text-slate-500 dark:text-slate-400">
            {sessionCount === 0
              ? "no active sessions"
              : `${sessionCount} active ${sessionCount === 1 ? "session" : "sessions"}`}
          </span>
          <span
            data-testid="login-email"
            className="text-xs text-slate-500 dark:text-slate-400"
          >
            {login.email ? login.email : "no email"}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {canInvite && login.email && (
            <button
              type="button"
              onClick={invite}
              disabled={pending}
              className="btn-ghost"
              data-testid="send-invite"
            >
              Send invite
            </button>
          )}
          <button
            type="button"
            onClick={() => setEmailOpen((v) => !v)}
            className="btn-ghost"
          >
            Email
          </button>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="btn-ghost"
          >
            Reset password
          </button>
          <button
            type="button"
            onClick={revokeSessions}
            disabled={pending || sessionCount === 0}
            title={
              sessionCount === 0
                ? "This login has no active sessions."
                : "Sign this login out of every device without changing the password."
            }
            className="btn-ghost"
          >
            Sign out devices
          </button>
          <button
            type="button"
            onClick={del}
            disabled={pending || isLastAdmin}
            title={
              isLastAdmin
                ? "The only admin login can't be deleted — create another admin first."
                : undefined
            }
            className="btn-ghost text-rose-600 dark:text-rose-400"
          >
            Delete
          </button>
        </div>
      </div>
      {emailOpen && (
        <div className="mt-3 flex items-end gap-2">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email address"
            type="email"
            autoComplete="off"
            data-testid="edit-email"
            className="input"
          />
          <button
            type="button"
            onClick={saveEmail}
            disabled={pending}
            className="btn shrink-0"
            data-testid="save-email"
          >
            Save
          </button>
        </div>
      )}
      {open && (
        <div className="mt-3 flex items-end gap-2">
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="New password"
            type="password"
            autoComplete="new-password"
            className="input"
          />
          <button
            type="button"
            onClick={reset}
            disabled={pending || !password}
            className="btn shrink-0"
          >
            Set
          </button>
        </div>
      )}
      <div className="mt-2">
        <Msg result={result} />
      </div>
    </div>
  );
}

// ---- Access grants matrix ----

function GrantsCard({
  logins,
  profiles,
  grants,
  access,
}: {
  logins: Login[];
  profiles: Profile[];
  grants: Record<number, number[]>;
  access: Record<number, Record<number, Access>>;
}) {
  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Access
        </h2>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Which profiles each member login can open, and at what level. A{" "}
          <strong>read-only</strong> grant can view everything but can’t add,
          edit, upload, or delete. Admins have full access to every profile
          automatically.
        </p>
      </div>

      {profiles.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Add a profile first.
        </p>
      ) : (
        <div className="space-y-2">
          {logins.map((a) => (
            <GrantsSummaryRow
              key={a.id}
              login={a}
              profiles={profiles}
              granted={grants[a.id] ?? []}
              access={access[a.id] ?? {}}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// One compact, at-rest row per login (issue #1412). Renders O(1) controls when
// collapsed — a username · role · "N of M profiles" summary (admins read "— all
// profiles (admin)") plus an Edit disclosure — so the whole card is O(logins), not
// the old O(logins × profiles) grid. Expanding ONE login lazily mounts its
// per-profile grant toggles (members only) + its own-profile <select>, so hydration
// is bounded by how many rows the admin actually opens rather than the fixture
// scale. The write model is untouched: the mounted GrantsRow/OwnProfileRow are the
// same controls, still saving through setGrants (grantSignature guard, #467) and the
// own-profile autosave (#1013). Once opened a row STAYS mounted on collapse (state
// kept, just hidden) so a half-edited grid isn't discarded by a fat-fingered toggle
// of the disclosure; the perf win is that unopened rows never mount at all.
function GrantsSummaryRow({
  login,
  profiles,
  granted,
  access,
}: {
  login: Login;
  profiles: Profile[];
  granted: number[];
  access: Record<number, Access>;
}) {
  const [open, setOpen] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  const isAdmin = login.role === "admin";
  // The profiles this login may act as — the choices for its own-profile (#1013): an
  // admin reaches every profile, a member only its grants. The server
  // (setOwnProfileForLogin) re-checks this constraint.
  const reachable = isAdmin
    ? profiles
    : profiles.filter((p) => granted.includes(p.id));

  return (
    <div
      data-testid={`grant-summary-${login.username}`}
      className="rounded-lg border border-black/10 p-3 dark:border-white/10"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-slate-800 dark:text-slate-100">
          {login.username}
        </span>
        <span
          className={`badge ${
            isAdmin
              ? "bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
              : "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300"
          }`}
        >
          {login.role}
        </span>
        <span
          data-testid={`grant-count-${login.username}`}
          className="text-xs text-slate-500 dark:text-slate-400"
        >
          {isAdmin
            ? "— all profiles (admin)"
            : grantCountSummary(granted, profiles.length)}
        </span>
        <button
          type="button"
          data-testid={`grant-edit-${login.username}`}
          onClick={() => {
            setEverOpened(true);
            setOpen((v) => !v);
          }}
          aria-expanded={open}
          className="btn-ghost ml-auto"
        >
          {open ? "Done" : "Edit"}
        </button>
      </div>
      {everOpened && (
        <div className={open ? "block" : "hidden"}>
          <div className="mt-3 space-y-2 border-t border-black/10 pt-3 dark:border-white/10">
            {!isAdmin && (
              <GrantsRow
                login={login}
                profiles={profiles}
                granted={granted}
                access={access}
              />
            )}
            <OwnProfileRow login={login} profiles={reachable} />
          </div>
        </div>
      )}
    </div>
  );
}

// Admin control for a login's own-profile association (issue #1013): which of the
// login's accessible profiles it considers "mine" (or none). An association, not an
// access grant — it only labels the login's self so its not-self write affordances
// name the subject. Constrained to the login's reachable profiles (the <select>
// lists exactly them; the server re-checks). Autosaves on change.
function OwnProfileRow({
  login,
  profiles,
}: {
  login: Login;
  profiles: Profile[];
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FamilyResult | null>(null);
  const [value, setValue] = useState<string>(
    login.own_profile_id != null ? String(login.own_profile_id) : "none"
  );

  function save(next: string) {
    const fd = new FormData();
    fd.set("loginId", String(login.id));
    fd.set("own_profile_id", next);
    start(async () => {
      const r = await setLoginOwnProfile(fd);
      setResult(r);
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-2 px-3 text-sm">
      <span className="text-xs text-slate-500 dark:text-slate-400">
        Own profile
      </span>
      <select
        aria-label={`Own profile for ${login.username}`}
        data-testid={`own-profile-${login.username}`}
        value={value}
        disabled={pending}
        onChange={(e) => {
          setValue(e.target.value);
          save(e.target.value);
        }}
        className="input h-8 w-44 py-0 text-sm disabled:opacity-40"
      >
        <option value="none">None</option>
        {profileChoiceLabels(profiles).map((c) => (
          <option key={c.id} value={String(c.id)}>
            {c.label}
          </option>
        ))}
      </select>
      <Msg result={result} />
    </div>
  );
}

function GrantsRow({
  login,
  profiles,
  granted,
  access,
}: {
  login: Login;
  profiles: Profile[];
  granted: number[];
  access: Record<number, Access>;
}) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FamilyResult | null>(null);
  // profile id → access level for each CURRENTLY-granted profile. Absence from
  // the map means "not granted"; a grant defaults to 'write' when its level is
  // unknown (matches the server's normalizeAccess).
  const [selected, setSelected] = useState<Map<number, Access>>(() =>
    initialGrantSelection(granted, access)
  );

  function toggle(id: number) {
    setSelected((prev) => toggleGrant(prev, id));
  }

  function setLevel(id: number, level: Access) {
    setSelected((prev) => setGrantLevel(prev, id, level));
  }

  function save() {
    const fd = new FormData();
    fd.set("loginId", String(login.id));
    // The grants this row LOADED with (issue #467): setGrants refuses the save if the
    // login's access changed server-side since then, instead of letting this stale
    // form's desired set silently revoke another admin's fresh grant.
    fd.set("grants_snapshot", loadedGrantSignature(granted, access));
    for (const { id, level } of grantFormEntries(selected)) {
      fd.append("profileId", String(id));
      fd.set(`access_${id}`, level);
    }
    start(async () => {
      const r = await setGrants(fd);
      setResult(r);
    });
  }

  return (
    <div data-testid={`grant-row-${login.username}`}>
      <div className="space-y-2">
        {/* Disambiguated labels (#534 via #1434): two same-named profiles are
            otherwise identical checkbox rows in the one place where granting the
            wrong person's record is the costliest mistake on this screen. */}
        {profileChoiceLabels(profiles).map(({ id: pid, label }) => {
          const isGranted = selected.has(pid);
          const level = selected.get(pid) ?? "write";
          return (
            <div
              key={pid}
              className="flex flex-wrap items-center gap-3"
              data-testid={`grant-cell-${login.username}-${pid}`}
            >
              <label className="flex min-w-[8rem] items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  data-testid={`grant-toggle-${login.username}-${pid}`}
                  checked={isGranted}
                  onChange={() => toggle(pid)}
                  className="h-4 w-4 accent-brand-600 focus:ring-brand-500"
                />
                {label}
              </label>
              <select
                aria-label={`Access level for ${label}`}
                data-testid={`grant-access-${login.username}-${pid}`}
                value={level}
                disabled={!isGranted}
                onChange={(e) => setLevel(pid, e.target.value as Access)}
                className="input h-8 w-32 py-0 text-sm disabled:opacity-40"
              >
                <option value="write">Read &amp; write</option>
                <option value="read">Read-only</option>
              </select>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={pending}
          data-testid={`grant-save-${login.username}`}
          className="btn-ghost"
        >
          Save access
        </button>
        <Msg result={result} />
      </div>
    </div>
  );
}
