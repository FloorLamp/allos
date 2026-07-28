"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import NotesText from "@/components/NotesText";
import { PageHeader } from "@/components/ui";
import { useConfirm } from "@/components/ConfirmDialog";
import OverflowMenu, {
  MENU_ITEM,
  MENU_ITEM_DANGER,
} from "@/components/OverflowMenu";
import { useToast } from "@/components/Toast";
import { formatLongDate } from "@/lib/format-date";
import { useFormatPrefs } from "@/components/FormatPrefsProvider";
import type { Protocol, FormResult, Equipment } from "@/lib/types";
import { protocolReopenEligibility } from "@/lib/protocol-reopen";
import type {
  OutcomeOption,
  ProtocolPractice,
  IntakeItemOption,
} from "@/lib/queries/protocols";
import ProtocolForm from "./ProtocolForm";

// Detail-page header + lifecycle controls for one protocol: an inline edit toggle
// (reusing ProtocolForm with the update action), an "End now" action for an
// ongoing protocol, and a confirm-guarded delete. End/Delete are plain server-
// action forms so their server-side redirect/revalidate flows straight through.
export default function ProtocolControls({
  protocol,
  options,
  equipment,
  intakeItems,
  practice,
  updateAction,
  endAction,
  resumeAction,
  runAgainAction,
  deleteAction,
  asOf,
}: {
  protocol: Protocol;
  options: OutcomeOption[];
  equipment: Equipment[];
  intakeItems: IntakeItemOption[];
  practice: ProtocolPractice | null;
  updateAction: (formData: FormData) => Promise<FormResult>;
  endAction: (formData: FormData) => Promise<FormResult>;
  resumeAction: (formData: FormData) => Promise<FormResult>;
  runAgainAction: (
    formData: FormData
  ) => Promise<FormResult & { redirectTo?: `/protocols/${number}` }>;
  deleteAction: (
    formData: FormData
  ) => Promise<FormResult & { redirectTo?: "/longevity#protocols" }>;
  asOf: string;
}) {
  const formatPrefs = useFormatPrefs();
  const [editing, setEditing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const router = useRouter();
  const toast = useToast();
  const ongoing = protocol.end_date == null;
  const reopen = protocolReopenEligibility(protocol.end_date, asOf);

  function idFormData() {
    const fd = new FormData();
    fd.set("id", String(protocol.id));
    return fd;
  }

  async function mutate(
    action: (fd: FormData) => Promise<FormResult>,
    success: string
  ) {
    setMenuOpen(false);
    setBusy(true);
    try {
      const result = await action(idFormData());
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      toast(success);
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onEnd() {
    const ok = await confirm({
      title: "End this protocol?",
      message:
        "The current comparison window will end today. You can resume it for seven days.",
      confirmLabel: "End protocol",
      danger: true,
    });
    if (ok) await mutate(endAction, "Protocol ended");
  }

  async function onDelete() {
    const ok = await confirm({
      title: "Delete this protocol?",
      message: `“${protocol.name}” and its comparison setup will be removed.`,
      confirmLabel: "Delete protocol",
      danger: true,
    });
    if (!ok) return;
    setMenuOpen(false);
    setBusy(true);
    try {
      const result = await deleteAction(idFormData());
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      router.push(result.redirectTo ?? "/longevity#protocols");
    } finally {
      setBusy(false);
    }
  }

  async function onRunAgain() {
    setMenuOpen(false);
    setBusy(true);
    try {
      const result = await runAgainAction(idFormData());
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return;
      }
      toast("New protocol run started");
      if (result.redirectTo) router.push(result.redirectTo);
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <ProtocolForm
        action={updateAction}
        options={options}
        equipment={equipment}
        intakeItems={intakeItems}
        protocol={protocol}
        practice={practice}
        onDone={() => setEditing(false)}
      />
    );
  }

  return (
    <div className="card space-y-3" data-testid="protocol-header">
      {/* The shared PageHeader, not a hand-rolled <h1> (issue #1416, section D):
      this IS the protocol detail page's heading, so it gets the same treatment —
      including the compact mobile size — as every other page. */}
      <PageHeader
        title={protocol.name}
        subtitle={
          ongoing
            ? `Started ${formatLongDate(protocol.start_date, formatPrefs)} · ongoing`
            : `${formatLongDate(protocol.start_date, formatPrefs)} – ${formatLongDate(
                protocol.end_date!,
                formatPrefs
              )}`
        }
        action={
          <div className="flex items-center gap-1">
            {ongoing && (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                Ongoing
              </span>
            )}
            <OverflowMenu
              label="More protocol actions"
              open={menuOpen}
              onOpenChange={setMenuOpen}
            >
              {({ close }) => (
                <>
                  <button
                    type="button"
                    className={MENU_ITEM}
                    disabled={busy}
                    data-testid="protocol-edit"
                    onClick={() => {
                      close();
                      setEditing(true);
                    }}
                  >
                    Edit
                  </button>
                  {ongoing && (
                    <button
                      type="button"
                      className={MENU_ITEM}
                      disabled={busy}
                      onClick={() => void onEnd()}
                    >
                      End now
                    </button>
                  )}
                  {reopen.kind === "eligible" && (
                    <button
                      type="button"
                      className={MENU_ITEM}
                      disabled={busy}
                      onClick={() =>
                        void mutate(resumeAction, "Protocol resumed")
                      }
                    >
                      Resume
                    </button>
                  )}
                  {reopen.kind === "expired" && (
                    <button
                      type="button"
                      className={MENU_ITEM}
                      disabled={busy}
                      onClick={() => void onRunAgain()}
                    >
                      Run again
                    </button>
                  )}
                  <button
                    type="button"
                    className={MENU_ITEM_DANGER}
                    disabled={busy}
                    onClick={() => void onDelete()}
                  >
                    Delete
                  </button>
                </>
              )}
            </OverflowMenu>
          </div>
        }
      />
      {protocol.situation && (
        <p className="text-sm text-slate-600 dark:text-slate-300">
          Situation: <span className="font-medium">{protocol.situation}</span>
        </p>
      )}
      <NotesText
        as="p"
        notes={protocol.notes}
        className="text-sm text-slate-600 dark:text-slate-300"
      />
    </div>
  );
}
