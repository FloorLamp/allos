"use client";

import { useState, useTransition } from "react";
import { useToast } from "@/components/Toast";
import DateField from "@/components/DateField";
import { setTtcStartAction } from "./ttc-actions";

// The DECLARATION control for trying to conceive (issue #1680) — the only thing that turns
// the TTC surfaces on, and the only thing that turns them off.
//
// Declared-only doctrine: the app never infers this from behavior. Logging an ovulation
// test is not a statement of intent, and a system that decided on someone's behalf that
// they were trying to conceive would be making the most personal call in the app without
// being asked.
//
// Stopping is deliberately as easy as starting, and stopping REMOVES ONLY the declaration:
// the observations already recorded are facts, and stay.
export default function TtcDeclareControl({
  ttcStart,
  today,
}: {
  ttcStart: string | null;
  today: string;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [date, setDate] = useState(ttcStart ?? today);

  function submit(value: string, okMsg: string) {
    setError(null);
    const fd = new FormData();
    fd.set("start", value);
    startTransition(async () => {
      let result: { ok: boolean; error?: string };
      try {
        result = await setTtcStartAction(fd);
      } catch {
        setError("Couldn't save that. Try again.");
        return;
      }
      if (!result.ok) {
        setError(result.error ?? "Couldn't save that.");
        return;
      }
      toast(okMsg);
    });
  }

  if (ttcStart) {
    return (
      <div className="space-y-2" data-testid="ttc-declare">
        <button
          type="button"
          className="btn-ghost"
          disabled={pending}
          data-testid="ttc-stop"
          onClick={() => submit("", "Trying-to-conceive tracking stopped")}
        >
          {pending ? "Saving…" : "Stop trying-to-conceive tracking"}
        </button>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          Stopping hides these surfaces. The observations you&rsquo;ve recorded
          stay exactly where they are.
        </p>
        {error && (
          <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2" data-testid="ttc-declare">
      <label className="section-label block" htmlFor="ttc-start">
        Date you started trying
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <DateField
          id="ttc-start"
          value={date}
          max={today}
          data-testid="ttc-start-input"
          onChange={setDate}
        />
        <button
          type="button"
          className="btn"
          disabled={pending || date === ""}
          data-testid="ttc-start-save"
          onClick={() => submit(date, "Trying-to-conceive tracking on")}
        >
          {pending ? "Saving…" : "Start tracking"}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-rose-600 dark:text-rose-400">
          {error}
        </p>
      )}
    </div>
  );
}
