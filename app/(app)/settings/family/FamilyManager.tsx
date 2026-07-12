"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Avatar from "@/components/Avatar";
import PhotoPicker from "@/components/PhotoPicker";
import { useConfirm } from "@/components/ConfirmDialog";
import { membersLosingAllAccess } from "@/lib/family-deletion";
import type { Access } from "@/lib/grants";
import {
  deletionErasesText,
  grantFormEntries,
  initialGrantSelection,
  loadedGrantSignature,
  memberGrantList,
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
}: {
  profiles: Profile[];
  logins: Login[];
  grants: Record<number, number[]>;
  access: Record<number, Record<number, Access>>;
  summaries: Record<number, ProfileDataSummary>;
  sessionCounts: Record<number, number>;
}) {
  return (
    <div className="max-w-3xl space-y-6">
      <ProfilesCard
        profiles={profiles}
        logins={logins}
        grants={grants}
        summaries={summaries}
      />
      <LoginsCard logins={logins} sessionCounts={sessionCounts} />
      <GrantsCard
        logins={logins}
        profiles={profiles}
        grants={grants}
        access={access}
      />
      <p className="text-xs text-slate-400 dark:text-slate-500">
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
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FamilyResult | null>(null);
  const [newName, setNewName] = useState("");
  const members = memberGrantList(logins, grants);

  function add() {
    const fd = new FormData();
    fd.set("name", newName);
    start(async () => {
      const r = await createProfile(fd);
      setResult(r);
      if (r.ok) {
        setNewName("");
        router.refresh();
      }
    });
  }

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Profiles
        </h2>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
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
            onDone={() => router.refresh()}
          />
        ))}
      </div>

      <div className="border-t border-black/10 pt-4 dark:border-white/10">
        <label className="label">Add a profile</label>
        <div className="flex items-end gap-2">
          <input
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
  onDone,
}: {
  profile: Profile;
  summary: ProfileDataSummary | undefined;
  losingAccess: string[];
  canDelete: boolean;
  onDone: () => void;
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
        onDone();
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
      if (r.ok) onDone();
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
          onDone={onDone}
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
          <div className="space-y-3 rounded-lg border border-rose-300 bg-rose-50 p-3 dark:border-rose-900/60 dark:bg-rose-950/30">
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
  sessionCounts,
}: {
  logins: Login[];
  sessionCounts: Record<number, number>;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FamilyResult | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const adminCount = logins.filter((a) => a.role === "admin").length;

  function create() {
    const fd = new FormData();
    fd.set("username", username);
    fd.set("password", password);
    fd.set("role", role);
    start(async () => {
      const r = await createLogin(fd);
      setResult(r);
      if (r.ok) {
        setUsername("");
        setPassword("");
        setRole("member");
        router.refresh();
      }
    });
  }

  return (
    <div className="card space-y-4">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Logins
        </h2>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
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
            onDone={() => router.refresh()}
          />
        ))}
      </div>

      <div className="space-y-3 border-t border-black/10 pt-4 dark:border-white/10">
        <label className="label">Add a login</label>
        <div className="grid gap-2 sm:grid-cols-3">
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            autoComplete="off"
            className="input"
          />
          <input
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            type="password"
            autoComplete="new-password"
            className="input"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as "admin" | "member")}
            className="input"
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={create}
            disabled={pending || !username.trim() || !password}
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
  onDone,
}: {
  login: Login;
  isLastAdmin: boolean;
  sessionCount: number;
  onDone: () => void;
}) {
  const confirm = useConfirm();
  const [pending, start] = useTransition();
  const [result, setResult] = useState<FamilyResult | null>(null);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");

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
        onDone();
      }
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
      if (r.ok) onDone();
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
          login, you&apos;ll be signed out.
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
      if (r.ok) onDone();
    });
  }

  return (
    <div className="rounded-lg border border-black/10 p-3 dark:border-white/10">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
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
          <span className="text-xs text-slate-400 dark:text-slate-500">
            {sessionCount === 0
              ? "no active sessions"
              : `${sessionCount} active ${sessionCount === 1 ? "session" : "sessions"}`}
          </span>
        </div>
        <div className="flex items-center gap-1">
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
            className="btn-ghost disabled:cursor-not-allowed disabled:text-slate-400 dark:disabled:text-slate-500"
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
            className="btn-ghost text-rose-600 disabled:cursor-not-allowed disabled:text-slate-400 dark:text-rose-400 dark:disabled:text-slate-500"
          >
            Delete
          </button>
        </div>
      </div>
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
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Which profiles each member login can open, and at what level. A
          <strong> read-only</strong> grant can view everything but can&apos;t
          add, edit, upload, or delete. Admins have full access to every profile
          automatically.
        </p>
      </div>

      {profiles.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Add a profile first.
        </p>
      ) : (
        <div className="space-y-3">
          {logins.map((a) =>
            a.role === "admin" ? (
              <div
                key={a.id}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-black/10 p-3 dark:border-white/10"
              >
                <span className="font-medium text-slate-800 dark:text-slate-100">
                  {a.username}
                </span>
                <span className="text-xs text-slate-400 dark:text-slate-500">
                  — all profiles (admin)
                </span>
              </div>
            ) : (
              <GrantsRow
                key={a.id}
                login={a}
                profiles={profiles}
                granted={grants[a.id] ?? []}
                access={access[a.id] ?? {}}
              />
            )
          )}
        </div>
      )}
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
  const router = useRouter();
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
      if (r.ok) router.refresh();
    });
  }

  return (
    <div
      className="rounded-lg border border-black/10 p-3 dark:border-white/10"
      data-testid={`grant-row-${login.username}`}
    >
      <div className="mb-2 font-medium text-slate-800 dark:text-slate-100">
        {login.username}
      </div>
      <div className="space-y-2">
        {profiles.map((p) => {
          const isGranted = selected.has(p.id);
          const level = selected.get(p.id) ?? "write";
          return (
            <div
              key={p.id}
              className="flex flex-wrap items-center gap-3"
              data-testid={`grant-cell-${login.username}-${p.id}`}
            >
              <label className="flex min-w-[8rem] items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <input
                  type="checkbox"
                  checked={isGranted}
                  onChange={() => toggle(p.id)}
                  className="h-4 w-4 accent-brand-600 focus:ring-brand-500"
                />
                {p.name}
              </label>
              <select
                aria-label={`Access level for ${p.name}`}
                data-testid={`grant-access-${login.username}-${p.id}`}
                value={level}
                disabled={!isGranted}
                onChange={(e) => setLevel(p.id, e.target.value as Access)}
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
          className="btn-ghost"
        >
          Save access
        </button>
        <Msg result={result} />
      </div>
    </div>
  );
}
