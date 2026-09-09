"use client";

import { useState } from "react";
import Link from "next/link";
import DateField from "@/components/DateField";
import Button from "@/components/Button";
import SubmitButton from "@/components/SubmitButton";
import EntryHistoryTable from "@/components/EntryHistoryTable";
import { EmptyState } from "@/components/ui";
import SourceDocumentLink from "@/components/SourceDocumentLink";
import type { AppRoute } from "@/lib/hrefs";
import type { FormResult } from "@/lib/types";

export interface InstrumentHistoryRow {
  id: number;
  instrument: string;
  date: string;
  total: number;
  bandLabel: string;
  // The instrument's maximum possible total, for the correction field's bounds.
  maxTotal: number;
  // Deep link to this instrument's trend, resolved on the server.
  href: AppRoute;
  documentId?: number | null;
}

export default function InstrumentHistoryList({
  rows,
  updateAction,
  deleteAction,
  testidPrefix,
  emptyMessage,
}: {
  rows: InstrumentHistoryRow[];
  updateAction: (fd: FormData) => Promise<FormResult>;
  deleteAction: (fd: FormData) => Promise<{ undoId: number | null }>;
  // "instrument" (mental health) or "substance" — keeps each surface's existing
  // per-row test ids stable.
  testidPrefix: string;
  emptyMessage: string;
}) {
  if (rows.length === 0) return <EmptyState message={emptyMessage} />;

  return (
    <EntryHistoryTable
      items={rows}
      columns={[
        {
          header: "Screening",
          slot: "title",
          cell: (row) => (
            <>
              <Link href={row.href} className="text-link">
                {row.instrument}
              </Link>{" "}
              <span className="text-slate-500 dark:text-slate-400">
                {row.date}
              </span>
            </>
          ),
        },
        {
          header: "Source",
          label: "Source",
          slot: "meta",
          empty: (row) => row.documentId == null,
          cell: (row) =>
            row.documentId != null ? (
              <SourceDocumentLink documentId={row.documentId}>
                Source document
              </SourceDocumentLink>
            ) : (
              "—"
            ),
        },
        {
          header: "Score",
          slot: "trailing",
          cell: (row) => (
            <>
              <span className="font-semibold">{row.total}</span> ·{" "}
              <span data-testid={`${testidPrefix}-reading-band-${row.id}`}>
                {row.bandLabel}
              </span>
            </>
          ),
        },
      ]}
      expandToggle={{
        collapsedLabel: `View all ${rows.length} scores`,
        expandedLabel: "Show fewer scores",
        testId: `${testidPrefix}-history-toggle`,
      }}
      menuKind="Reading"
      menuItemName={(row) => row.date}
      rowTestId={(row) => `${testidPrefix}-reading-${row.id}`}
      editTestId={(row) => `${testidPrefix}-reading-edit-${row.id}`}
      deleteTestId={(row) => `${testidPrefix}-reading-delete-${row.id}`}
      editLabel="Correct"
      deleteLabel="Remove"
      renderEditForm={(row, done) => (
        <ScoreCorrectionForm
          row={row}
          updateAction={updateAction}
          testidPrefix={testidPrefix}
          done={done}
        />
      )}
      confirmDelete={(row) => ({
        title: "Remove score",
        message: `Remove the ${row.instrument} score of ${row.total} from ${row.date}?`,
        confirmLabel: "Remove",
      })}
      deleteFormData={(row) => {
        const fd = new FormData();
        fd.set("id", String(row.id));
        return fd;
      }}
      deleteAction={deleteAction}
      deletedMessage="Score removed."
    />
  );
}

// The domain form keeps the action's refusal visible until corrected or cancelled.
function ScoreCorrectionForm({
  row,
  updateAction,
  testidPrefix,
  done,
}: {
  row: InstrumentHistoryRow;
  updateAction: (fd: FormData) => Promise<FormResult>;
  testidPrefix: string;
  done: () => void;
}) {
  const [error, setError] = useState<string | null>(null);

  async function save(formData: FormData) {
    setError(null);
    formData.set("id", String(row.id));
    let result: FormResult;
    try {
      result = await updateAction(formData);
    } catch {
      setError("Couldn't save that correction. Try again.");
      return;
    }
    if (!result.ok) {
      setError(result.error);
      return;
    }
    done();
  }

  return (
    <>
      <form
        action={save}
        className="flex flex-wrap items-end gap-3"
        data-testid={`${testidPrefix}-reading-edit-form-${row.id}`}
      >
        <div>
          <label className="label" htmlFor={`score-date-${row.id}`}>
            Date
          </label>
          <DateField
            id={`score-date-${row.id}`}
            data-testid={`${testidPrefix}-reading-date-${row.id}`}
            name="date"
            defaultValue={row.date}
            required
          />
        </div>
        <div>
          <label className="label" htmlFor={`score-total-${row.id}`}>
            Total (0–{row.maxTotal})
          </label>
          <input
            id={`score-total-${row.id}`}
            data-testid={`${testidPrefix}-reading-total-${row.id}`}
            name="total"
            type="number"
            inputMode="numeric"
            min={0}
            max={row.maxTotal}
            step={1}
            className="input w-28"
            defaultValue={row.total}
            required
          />
        </div>
        <Button
          data-testid={`${testidPrefix}-reading-edit-${row.id}`}
          onClick={done}
        >
          Cancel
        </Button>
        <SubmitButton pendingLabel="Saving…" variant="primary">
          Save
        </SubmitButton>
      </form>
      {error ? (
        <p
          role="alert"
          className="mt-2 text-sm text-rose-600 dark:text-rose-400"
          data-testid={`${testidPrefix}-reading-error-${row.id}`}
        >
          {error}
        </p>
      ) : null}
    </>
  );
}
