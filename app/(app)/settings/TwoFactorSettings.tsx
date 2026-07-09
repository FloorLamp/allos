"use client";

import { useState, useTransition } from "react";
import {
  begin2fa,
  activate2fa,
  disable2fa,
  regenerate2faRecoveryCodes,
} from "./actions";

// Two-factor authentication (issue #23), login-scoped. Enrollment is a three-step
// flow: generate a secret (begin2fa) → show the otpauth:// URI + manual key →
// verify one code (activate2fa) → show the one-time recovery codes ONCE. When 2FA
// is already on, the card instead offers "regenerate recovery codes" (needs a
// code) and "turn off" (needs password + code). No QR image is rendered — the
// copyable otpauth:// URI and manual key are dependency-free and sufficient.

function RecoveryCodeList({ codes }: { codes: string[] }) {
  return (
    <div
      className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3"
      data-testid="twofa-recovery-codes"
    >
      <p className="mb-2 text-xs font-medium text-amber-700 dark:text-amber-300">
        Save these recovery codes somewhere safe. Each works once if you lose
        your authenticator. They are shown only now.
      </p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-sm text-slate-800 dark:text-slate-100">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </div>
  );
}

export default function TwoFactorSettings({
  enabled,
  recoveryRemaining,
}: {
  enabled: boolean;
  recoveryRemaining: number;
}) {
  const [pending, start] = useTransition();
  // Enrollment state.
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [enrollCode, setEnrollCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Manage (already-enabled) state.
  const [disablePw, setDisablePw] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [regenCode, setRegenCode] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  function beginEnroll() {
    setError(null);
    start(async () => {
      const r = await begin2fa();
      if (r.ok) {
        setSecret(r.secret);
        setOtpauthUrl(r.otpauthUrl);
      } else setError(r.error);
    });
  }

  function activate() {
    setError(null);
    const fd = new FormData();
    fd.set("code", enrollCode);
    start(async () => {
      const r = await activate2fa(fd);
      if (r.ok) {
        setRecoveryCodes(r.recoveryCodes);
        setSecret(null);
        setOtpauthUrl(null);
        setEnrollCode("");
      } else setError(r.error);
    });
  }

  function turnOff() {
    setError(null);
    setStatus(null);
    const fd = new FormData();
    fd.set("current_password", disablePw);
    fd.set("code", disableCode);
    start(async () => {
      const r = await disable2fa(fd);
      if (r.ok) {
        setStatus(r.message);
        setDisablePw("");
        setDisableCode("");
      } else setError(r.error);
    });
  }

  function regenerate() {
    setError(null);
    setStatus(null);
    const fd = new FormData();
    fd.set("code", regenCode);
    start(async () => {
      const r = await regenerate2faRecoveryCodes(fd);
      if (r.ok) {
        setRecoveryCodes(r.recoveryCodes);
        setRegenCode("");
      } else setError(r.error);
    });
  }

  return (
    <div className="card mt-6 max-w-lg space-y-4" data-testid="twofa-card">
      <div>
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Two-factor authentication
        </h2>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Add a time-based one-time code (TOTP) from an authenticator app as a
          second step at sign-in. Strongly recommended, especially for admins.
        </p>
      </div>

      {/* ----- Already enabled ----- */}
      {enabled && !recoveryCodes && (
        <div className="space-y-4">
          <p
            className="text-sm font-medium text-emerald-600 dark:text-emerald-400"
            data-testid="twofa-status-on"
          >
            Two-factor authentication is ON. {recoveryRemaining} recovery code
            {recoveryRemaining === 1 ? "" : "s"} remaining.
          </p>

          <div className="space-y-2 border-t border-black/5 pt-3 dark:border-white/5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Regenerate recovery codes (replaces the current set)
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={regenCode}
                onChange={(e) => setRegenCode(e.target.value)}
                placeholder="Authenticator code"
                className="input"
                inputMode="numeric"
              />
              <button
                type="button"
                onClick={regenerate}
                disabled={pending || !regenCode}
                className="btn"
              >
                Regenerate
              </button>
            </div>
          </div>

          <div className="space-y-2 border-t border-black/5 pt-3 dark:border-white/5">
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
              Turn off two-factor authentication
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                value={disablePw}
                onChange={(e) => setDisablePw(e.target.value)}
                placeholder="Current password"
                type="password"
                autoComplete="current-password"
                className="input"
              />
              <input
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                placeholder="Authenticator or recovery code"
                className="input"
              />
            </div>
            <button
              type="button"
              onClick={turnOff}
              disabled={pending || !disablePw || !disableCode}
              className="btn"
            >
              Turn off
            </button>
          </div>
        </div>
      )}

      {/* ----- Not enabled: start / continue enrollment ----- */}
      {!enabled && !secret && !recoveryCodes && (
        <button
          type="button"
          onClick={beginEnroll}
          disabled={pending}
          className="btn"
          data-testid="twofa-enable"
        >
          Enable two-factor authentication
        </button>
      )}

      {!enabled && secret && (
        <div className="space-y-3">
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Add this account to your authenticator app, then enter the 6-digit
            code it shows to finish.
          </p>
          <div className="space-y-1">
            <p className="text-xs text-slate-400 dark:text-slate-500">
              Manual key (base32)
            </p>
            <code
              className="block break-all rounded bg-black/5 p-2 font-mono text-sm dark:bg-white/5"
              data-testid="twofa-secret"
            >
              {secret}
            </code>
          </div>
          {otpauthUrl && (
            <div className="space-y-1">
              <p className="text-xs text-slate-400 dark:text-slate-500">
                otpauth:// URI (paste into your app if it supports it)
              </p>
              <code className="block break-all rounded bg-black/5 p-2 font-mono text-xs dark:bg-white/5">
                {otpauthUrl}
              </code>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={enrollCode}
              onChange={(e) => setEnrollCode(e.target.value)}
              placeholder="6-digit code"
              className="input"
              inputMode="numeric"
              data-testid="twofa-code"
            />
            <button
              type="button"
              onClick={activate}
              disabled={pending || !enrollCode}
              className="btn"
              data-testid="twofa-activate"
            >
              Verify &amp; turn on
            </button>
          </div>
        </div>
      )}

      {recoveryCodes && <RecoveryCodeList codes={recoveryCodes} />}

      {status && (
        <p className="text-sm text-emerald-600 dark:text-emerald-400">
          {status}
        </p>
      )}
      {error && (
        <p className="text-sm text-rose-600 dark:text-rose-400" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
