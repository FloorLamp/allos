"use server";

import { revalidateRoute } from "@/lib/revalidate";
import { requireWriteAccess } from "@/lib/auth";
import { getUnitPrefs } from "@/lib/settings";
import { getIntegration } from "@/lib/integrations/registry";
import type { IntegrationId } from "@/lib/types";
import {
  correctionSignature,
  formatCorrectionValue,
  isCorrectionFieldId,
  planCorrection,
  resolveCorrectionOp,
  CORRECTION_FIELDS,
  type CorrectionFieldId,
  type RawCorrectionOp,
} from "@/lib/bulk-correction";
import {
  applyBulkCorrection,
  readCorrectionRows,
  undoBulkCorrection,
  type CorrectionFilter,
} from "@/lib/bulk-correction-db";

// Bulk corrections (issue #1603) — the request boundary. The gate shape is the
// usual one and stays HERE: requireWriteAccess() → parse/validate → the
// auth-blind core (lib/bulk-correction-db.ts) → revalidate. Units convert at
// this boundary (resolveCorrectionOp / formatCorrectionValue) and every outcome
// is typed — the panel renders what actually happened, never an unconditional
// success.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

interface ParsedRequest {
  field: CorrectionFieldId;
  filter: CorrectionFilter;
}

/** What the panel submits for preview and apply. Serializable-flat. */
export interface BulkCorrectionRequest {
  field: string;
  from: string;
  to: string;
  /** null selects manual rows (source IS NULL). */
  source: string | null;
  op: RawCorrectionOp;
}

function parseRequest(input: BulkCorrectionRequest): ParsedRequest | null {
  if (!isCorrectionFieldId(input.field)) return null;
  const from = String(input.from ?? "").trim();
  const to = String(input.to ?? "").trim();
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return null;
  const source =
    typeof input.source === "string" && input.source.trim() !== ""
      ? input.source.trim()
      : null;
  return { field: input.field, filter: { from, to, source } };
}

function sourceName(source: string | null): string {
  if (source === null || source === "manual") return "manual entries";
  return getIntegration(source as IntegrationId)?.name ?? source;
}

export type BulkCorrectionPreviewResult =
  | {
      ok: true;
      signature: string;
      count: number;
      unchanged: number;
      /** "N rows · before A–B → after C–D", display units. */
      summaryLine: string;
      /** The plain-words #133 warning, null when no lock will be set. */
      lockNote: string | null;
      /** The first few changes for the eyeball check, display-formatted. */
      sample: { date: string; before: string; after: string }[];
    }
  | { ok: false; error: "invalid" | "empty" | "out-of-range"; message: string };

const PREVIEW_SAMPLE_LIMIT = 8;

export async function previewBulkCorrection(
  input: BulkCorrectionRequest
): Promise<BulkCorrectionPreviewResult> {
  const { login, profile } = await requireWriteAccess();
  const parsed = parseRequest(input);
  const units = getUnitPrefs(login.id);
  const op = parsed && resolveCorrectionOp(parsed.field, input.op, units);
  if (!parsed || !op) {
    return {
      ok: false,
      error: "invalid",
      message: "Check the field, dates, and amount — something is missing.",
    };
  }

  const rows = readCorrectionRows(profile.id, parsed.field, parsed.filter);
  const plan = planCorrection(parsed.field, rows, op);
  if (!plan.ok) {
    return {
      ok: false,
      error: "out-of-range",
      message: `That change would push ${plan.count} ${plan.count === 1 ? "row" : "rows"} outside the valid range for ${CORRECTION_FIELDS[parsed.field].label.toLowerCase()}, so nothing was changed.`,
    };
  }
  if (plan.changes.length === 0 || plan.summary === null) {
    return {
      ok: false,
      error: "empty",
      message:
        rows.length === 0
          ? "No rows match that field, source, and date range."
          : "That change leaves every matching row exactly as it is.",
    };
  }

  const fmt = (v: number) => formatCorrectionValue(parsed.field, v, units);
  const s = plan.summary;
  const range = (lo: number, hi: number) =>
    lo === hi ? fmt(lo) : `${fmt(lo)} – ${fmt(hi)}`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  // The lock warning counts the rows whose #133 edit lock THIS apply would set —
  // said plainly, because it is the line that stops the next rolling-window sync
  // from silently un-correcting everything.
  const toLock = plan.changes.filter((c) => {
    const row = byId.get(c.id);
    return row !== undefined && row.source !== null && !row.edited;
  }).length;
  return {
    ok: true,
    signature: correctionSignature(plan.changes),
    count: plan.changes.length,
    unchanged: plan.unchanged,
    summaryLine: `${plan.changes.length} ${plan.changes.length === 1 ? "row" : "rows"} · ${range(s.beforeMin, s.beforeMax)} → ${range(s.afterMin, s.afterMax)}`,
    lockNote:
      toLock > 0 && parsed.filter.source !== null
        ? `These ${toLock} ${toLock === 1 ? "row" : "rows"} came from ${sourceName(parsed.filter.source)} and will stop receiving sync updates once corrected.`
        : null,
    sample: plan.changes.slice(0, PREVIEW_SAMPLE_LIMIT).map((c) => ({
      date: byId.get(c.id)?.date ?? "",
      before: fmt(c.before),
      after: fmt(c.after),
    })),
  };
}

export type BulkCorrectionApplyResult =
  | { ok: true; undoId: number; applied: number; message: string }
  | {
      ok: false;
      error: "invalid" | "empty" | "out-of-range" | "drift";
      message: string;
    };

export async function applyBulkCorrectionAction(
  input: BulkCorrectionRequest & { signature: string }
): Promise<BulkCorrectionApplyResult> {
  const { login, profile } = await requireWriteAccess();
  const parsed = parseRequest(input);
  const op = parsed && resolveCorrectionOp(parsed.field, input.op, getUnitPrefs(login.id));
  const signature = String(input.signature ?? "");
  if (!parsed || !op || signature === "") {
    return {
      ok: false,
      error: "invalid",
      message: "Check the field, dates, and amount — something is missing.",
    };
  }

  const outcome = applyBulkCorrection(
    profile.id,
    parsed.field,
    parsed.filter,
    op,
    signature
  );
  if (!outcome.ok) {
    return {
      ok: false,
      error: outcome.error,
      message:
        outcome.error === "drift"
          ? "This data changed while you were previewing (a sync may have landed). Nothing was applied — preview again to see the current rows."
          : outcome.error === "empty"
            ? "Nothing matched — nothing was applied."
            : "That change would push rows outside the valid range, so nothing was applied.",
    };
  }
  // The corrected series renders on the dashboard, Trends, Timeline, Training,
  // and Data → Manage — a layout-wide revalidate, the undo-toast precedent.
  revalidateRoute("/", "layout");
  return {
    ok: true,
    undoId: outcome.undoId,
    applied: outcome.applied,
    message: `Corrected ${outcome.applied} ${outcome.applied === 1 ? "row" : "rows"}.`,
  };
}

export type BulkCorrectionUndoResult =
  | { ok: true; restored: number; skipped: number; message: string }
  | { ok: false; message: string };

export async function undoBulkCorrectionAction(
  undoId: number
): Promise<BulkCorrectionUndoResult> {
  const { profile } = await requireWriteAccess();
  if (!Number.isInteger(undoId) || undoId <= 0)
    return { ok: false, message: "That correction can no longer be undone." };
  const outcome = undoBulkCorrection(profile.id, undoId);
  if (!outcome.ok) {
    return {
      ok: false,
      message: "That correction can no longer be undone (already undone, or older than 24 hours).",
    };
  }
  if (outcome.restored > 0) revalidateRoute("/", "layout");
  return {
    ok: true,
    restored: outcome.restored,
    skipped: outcome.skipped,
    message:
      outcome.skipped === 0
        ? `Restored ${outcome.restored} ${outcome.restored === 1 ? "row" : "rows"}.`
        : `Restored ${outcome.restored} ${outcome.restored === 1 ? "row" : "rows"}; ${outcome.skipped} ${outcome.skipped === 1 ? "row" : "rows"} changed since this correction and ${outcome.skipped === 1 ? "was" : "were"} left alone.`,
  };
}
