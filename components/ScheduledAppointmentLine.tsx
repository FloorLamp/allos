"use client";

import Link from "next/link";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import { formatRecordDate } from "@/lib/record-format";
import type { ScheduledAppointmentRef } from "@/lib/care-plan-appointment";

export default function ScheduledAppointmentLine({
  appointment,
}: {
  appointment: ScheduledAppointmentRef;
}) {
  const fmt = useFormatPrefs();
  return (
    <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">
      Scheduled: {appointment.title?.trim() || "Appointment"}{" "}
      <Link
        href="/records/history/visits"
        className="underline decoration-slate-300 underline-offset-2 hover:text-slate-700 dark:decoration-slate-600 dark:hover:text-slate-200"
      >
        {formatRecordDate(appointment.date, appointment.date, fmt)}
      </Link>
    </span>
  );
}
