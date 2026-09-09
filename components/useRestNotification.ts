"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const PREFERENCE_KEY = "allos-rest-notifications";
type Choice = "enabled" | "disabled" | "asked";

// A device-local rest choice is separate from permission granted for health push.
export function useRestNotification() {
  const [choice, setChoice] = useState<Choice | null>(null);
  const [permission, setPermission] =
    useState<NotificationPermission>("default");
  const [availability, setAvailability] = useState<
    "checking" | "ready" | "unavailable"
  >("checking");
  const [enabling, setEnabling] = useState(false);
  const [requestFailed, setRequestFailed] = useState(false);
  const choiceRef = useRef<Choice | null>(null);
  const storageAvailableRef = useRef(true);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const mountedRef = useRef(false);
  const requestingRef = useRef(false);

  const readCurrentChoice = useCallback((): Choice | null => {
    if (!storageAvailableRef.current) return choiceRef.current;
    try {
      const value = localStorage.getItem(PREFERENCE_KEY);
      // Removing the key can turn consent off, but cannot make this mount unasked.
      if (value === null) return choiceRef.current === null ? null : "disabled";
      return value === "enabled"
        ? "enabled"
        : value === "disabled"
          ? "disabled"
          : "asked";
    } catch {
      storageAvailableRef.current = false;
      return choiceRef.current;
    }
  }, []);

  const remember = useCallback((next: Choice) => {
    choiceRef.current = next;
    setChoice(next);
    try {
      localStorage.setItem(PREFERENCE_KEY, next);
    } catch {
      // The explicit choice still works in this mount when storage is unavailable.
      storageAvailableRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let generation = 0;
    const syncChoice = () => {
      choiceRef.current = readCurrentChoice();
      setChoice(choiceRef.current);
    };
    const supported =
      window.isSecureContext &&
      "Notification" in window &&
      "serviceWorker" in navigator;
    const refresh = async () => {
      const current = ++generation;
      registrationRef.current = null;
      syncChoice();
      if (!supported) {
        setAvailability("unavailable");
        return;
      }
      setPermission(Notification.permission);
      setAvailability("checking");
      try {
        // Unlike ready, this lookup also settles when no worker is registered.
        const registration = await navigator.serviceWorker.getRegistration();
        if (!mountedRef.current || current !== generation) return;
        registrationRef.current = registration ?? null;
        setAvailability(
          registration?.active?.state === "activated" ? "ready" : "unavailable"
        );
      } catch {
        if (mountedRef.current && current === generation)
          setAvailability("unavailable");
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const onController = () => void refresh();
    const onStorage = (event: StorageEvent) => {
      if (event.key === PREFERENCE_KEY || event.key === null) syncChoice();
    };
    void refresh();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("storage", onStorage);
    if (supported)
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        onController
      );
    return () => {
      mountedRef.current = false;
      generation++;
      registrationRef.current = null;
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("storage", onStorage);
      if (supported)
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          onController
        );
    };
  }, [readCurrentChoice]);

  const enable = async () => {
    if (
      registrationRef.current?.active?.state !== "activated" ||
      requestingRef.current
    )
      return;
    const current = Notification.permission;
    setPermission(current);
    if (current === "granted") {
      remember("enabled");
      setRequestFailed(false);
      return;
    }
    if (current !== "default" || readCurrentChoice() !== null) return;
    // Synchronous gesture boundary: preserve asked history before opening the prompt.
    remember("asked");
    requestingRef.current = true;
    setEnabling(true);
    setRequestFailed(false);
    try {
      const result = await Notification.requestPermission();
      if (!mountedRef.current) return;
      setPermission(result);
      if (result === "granted" && readCurrentChoice() === "asked")
        remember("enabled");
    } catch {
      if (mountedRef.current) setRequestFailed(true);
    } finally {
      requestingRef.current = false;
      if (mountedRef.current) setEnabling(false);
    }
  };

  // True only when the worker actually took the message: the caller falls back to
  // its own cue for every condition this path cannot announce.
  const notify = useCallback((): boolean => {
    const worker = registrationRef.current?.active;
    if (
      !mountedRef.current ||
      document.visibilityState === "visible" ||
      readCurrentChoice() !== "enabled" ||
      !("Notification" in window) ||
      Notification.permission !== "granted" ||
      worker?.state !== "activated"
    )
      return false;
    try {
      // One immediate attempt, never a pending alarm waiting for registration.
      worker.postMessage({ type: "allos-rest-done" });
      return true;
    } catch {
      // A stale worker loses this attempt; the timer's done state remains truthful.
      return false;
    }
  }, [readCurrentChoice]);

  const status =
    availability === "checking"
      ? "Checking availability…"
      : availability === "unavailable"
        ? "Rest notifications aren’t available here."
        : permission === "denied"
          ? "Notifications are blocked in your browser settings."
          : requestFailed
            ? "Notifications couldn’t be enabled."
            : permission === "default" && choice !== null
              ? "Allow notifications in your browser settings to enable this."
              : choice === "enabled" && permission === "granted"
                ? "On for this browser."
                : "Off for this browser.";

  return {
    optedIn: choice === "enabled",
    status,
    enabling,
    canEnable:
      availability === "ready" &&
      !enabling &&
      (permission === "granted" ||
        (permission === "default" && choice === null)),
    enable,
    disable: () => remember("disabled"),
    notify,
  };
}
