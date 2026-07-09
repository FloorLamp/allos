"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getPushPublicKey,
  savePushSubscriptionAction,
  deletePushSubscriptionAction,
  sendTestPush,
} from "./actions";

// Web Push opt-in (issue #17), LOGIN-scoped: a subscription belongs to THIS
// browser + login, so it lives on Preferences (which is login-scoped), not the
// per-profile notification card. Mirrors the Telegram "send test" affordance.
//
// This is the only client surface that touches the Push API. Real push delivery
// needs a live push service + a registered service worker, so it only works in a
// production (HTTPS, SW-registered) context; in dev the SW is unregistered and
// the controls sit disabled with an explanatory note.

// VAPID public keys are base64url; the browser's applicationServerKey wants raw
// bytes. Standard conversion (pad, url→std alphabet, atob → Uint8Array).
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

type Perm = "default" | "granted" | "denied";

export default function PushNotificationSettings() {
  const router = useRouter();
  // null = still probing; false = this browser can't do push.
  const [supported, setSupported] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<Perm>("default");
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(
    null
  );

  const refreshSubscription = useCallback(async () => {
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      setSubscribed(!!sub);
    } catch {
      setSubscribed(false);
    }
  }, []);

  useEffect(() => {
    const ok =
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      typeof window !== "undefined" &&
      "PushManager" in window &&
      "Notification" in window;
    setSupported(ok);
    if (!ok) return;
    setPermission(Notification.permission as Perm);
    void refreshSubscription();
  }, [refreshSubscription]);

  async function enable() {
    setBusy(true);
    setResult(null);
    try {
      const perm = (await Notification.requestPermission()) as Perm;
      setPermission(perm);
      if (perm !== "granted") {
        setResult({
          ok: false,
          message:
            "Notification permission was not granted — enable it in your browser’s site settings.",
        });
        return;
      }
      const key = await getPushPublicKey();
      if (!key.ok || !key.publicKey) {
        setResult({ ok: false, message: "Could not initialize push keys." });
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(
          key.publicKey
        ) as BufferSource,
      });
      const fd = new FormData();
      fd.set("subscription", JSON.stringify(sub));
      const res = await savePushSubscriptionAction(fd);
      if (!res.ok) {
        setResult({
          ok: false,
          message: res.error ?? "Could not save subscription.",
        });
        return;
      }
      setSubscribed(true);
      setResult({ ok: true, message: "Push enabled on this browser ✅" });
      router.refresh();
    } catch (e) {
      setResult({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setResult(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe();
        const fd = new FormData();
        fd.set("endpoint", endpoint);
        await deletePushSubscriptionAction(fd);
      }
      setSubscribed(false);
      setResult({ ok: true, message: "Push disabled on this browser." });
      router.refresh();
    } catch (e) {
      setResult({
        ok: false,
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  async function test() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await sendTestPush());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card mt-6 max-w-lg space-y-4" data-testid="push-settings">
      <h2 className="font-semibold text-slate-800 dark:text-slate-100">
        Web Push notifications
      </h2>
      <p className="text-xs text-slate-400 dark:text-slate-500">
        Get the same reminders as a browser notification on this device — no
        Telegram needed. Subscriptions belong to this browser and cover every
        profile your login can access.
      </p>

      {supported === false && (
        <p
          className="text-xs text-amber-600 dark:text-amber-400"
          data-testid="push-status"
        >
          This browser can’t receive web push (needs a service worker + HTTPS).
          Push works on the installed/production app, not in local dev.
        </p>
      )}

      {supported && permission === "denied" && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Notifications are blocked for this site. Allow them in your browser’s
          site settings, then reload.
        </p>
      )}

      {supported && (
        <>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            Status:{" "}
            <span
              className={
                subscribed
                  ? "font-medium text-emerald-600 dark:text-emerald-400"
                  : "text-slate-500 dark:text-slate-400"
              }
              data-testid="push-status"
            >
              {subscribed
                ? "Enabled on this browser"
                : "Not enabled on this browser"}
            </span>
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {!subscribed ? (
              <button
                type="button"
                onClick={enable}
                disabled={busy || permission === "denied"}
                className="btn"
                data-testid="push-enable"
              >
                Enable push on this browser
              </button>
            ) : (
              <button
                type="button"
                onClick={disable}
                disabled={busy}
                className="btn-ghost"
                data-testid="push-disable"
              >
                Disable
              </button>
            )}
            {/* Test targets every browser subscribed under this login, so it's
                useful even when THIS browser isn't subscribed. */}
            <button
              type="button"
              onClick={test}
              disabled={busy}
              className="btn-ghost"
              data-testid="push-test"
            >
              Send test notification
            </button>
          </div>
        </>
      )}

      {result && (
        <p
          className={`text-sm ${
            result.ok
              ? "text-emerald-600 dark:text-emerald-400"
              : "text-rose-600 dark:text-rose-400"
          }`}
          data-testid="push-result"
        >
          {result.message}
        </p>
      )}
    </div>
  );
}
