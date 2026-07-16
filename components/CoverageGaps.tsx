"use client";

import { useState, useTransition } from "react";
import {
  IconSparkles,
  IconCopy,
  IconExternalLink,
  IconX,
  IconPlus,
  IconCircleCheck,
} from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import type {
  CoverageGap,
  CoverageGapCandidate,
  CoverageGapKind,
  CatalogRequest,
} from "@/lib/coverage-gaps";
import {
  trackCoverageGap,
  untrackCoverageGap,
  enrichCoverageGapAction,
} from "@/app/(app)/coverage/actions";

const KIND_LABEL: Record<CoverageGapKind, string> = {
  biomarker: "Biomarker",
  medication: "Medication",
  condition: "Condition",
};

function KindBadge({ kind }: { kind: CoverageGapKind }) {
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300">
      {KIND_LABEL[kind]}
    </span>
  );
}

export default function CoverageGaps({
  tracked,
  candidates,
  requests,
  aiConfigured,
  aiLabel,
}: {
  tracked: CoverageGap[];
  candidates: CoverageGapCandidate[];
  requests: Record<number, CatalogRequest>;
  aiConfigured: boolean;
  aiLabel: string;
}) {
  const covered = tracked.filter((g) => g.covered);
  const openGaps = tracked.filter((g) => !g.covered);

  return (
    <div className="space-y-8">
      {covered.length > 0 && (
        <section data-testid="section-now-available">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-emerald-700 dark:text-emerald-400">
            <IconCircleCheck className="h-4 w-4" /> Now available
          </h2>
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            A catalog update now covers these — reference context is available
            on their pages. You can stop tracking them.
          </p>
          <ul className="space-y-3">
            {covered.map((g) => (
              <TrackedRow
                key={g.id}
                gap={g}
                request={requests[g.id]}
                aiConfigured={aiConfigured}
                aiLabel={aiLabel}
              />
            ))}
          </ul>
        </section>
      )}

      {openGaps.length > 0 && (
        <section data-testid="section-tracked">
          <h2 className="mb-3 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Tracked gaps
          </h2>
          <ul className="space-y-3">
            {openGaps.map((g) => (
              <TrackedRow
                key={g.id}
                gap={g}
                request={requests[g.id]}
                aiConfigured={aiConfigured}
                aiLabel={aiLabel}
              />
            ))}
          </ul>
        </section>
      )}

      {candidates.length > 0 && (
        <section data-testid="section-candidates">
          <h2 className="mb-1 text-sm font-semibold text-slate-700 dark:text-slate-200">
            Uncatalogued items
          </h2>
          <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
            These are on your record but the curated catalogs don&apos;t cover
            them. Track one to add context or request it be catalogued.
          </p>
          <ul className="space-y-2">
            {candidates.map((c) => (
              <CandidateRow key={`${c.kind}:${c.itemKey}`} candidate={c} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function CandidateRow({ candidate }: { candidate: CoverageGapCandidate }) {
  const [pending, startTransition] = useTransition();
  function onTrack() {
    const fd = new FormData();
    fd.set("kind", candidate.kind);
    fd.set("item_key", candidate.itemKey);
    fd.set("label", candidate.label);
    startTransition(() => trackCoverageGap(fd));
  }
  return (
    <li
      data-testid="coverage-candidate"
      data-kind={candidate.kind}
      className="flex items-center justify-between gap-3 rounded-lg border border-black/10 px-3 py-2 dark:border-white/10"
    >
      <span className="flex min-w-0 items-center gap-2">
        <KindBadge kind={candidate.kind} />
        <span className="truncate text-sm text-slate-800 dark:text-slate-100">
          {candidate.label}
        </span>
      </span>
      <button
        type="button"
        onClick={onTrack}
        disabled={pending}
        data-testid="track-gap"
        className="btn-ghost inline-flex shrink-0 items-center gap-1 text-xs disabled:opacity-50"
      >
        <IconPlus className="h-3.5 w-3.5" /> Track
      </button>
    </li>
  );
}

function TrackedRow({
  gap,
  request,
  aiConfigured,
  aiLabel,
}: {
  gap: CoverageGap;
  request: CatalogRequest | undefined;
  aiConfigured: boolean;
  aiLabel: string;
}) {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [enriching, setEnriching] = useState(false);

  function onUntrack() {
    const fd = new FormData();
    fd.set("id", String(gap.id));
    startTransition(() => untrackCoverageGap(fd));
  }

  async function onEnrich() {
    setEnriching(true);
    try {
      const fd = new FormData();
      fd.set("id", String(gap.id));
      const outcome = await enrichCoverageGapAction(fd);
      if (outcome.status === "ok") {
        toast("Context generated.", { tone: "success" });
      } else if (outcome.status === "not-configured") {
        toast(
          "No AI backend configured. Set ANTHROPIC_API_KEY or AI_BASE_URL to generate context privately.",
          { tone: "error" }
        );
      } else if (outcome.status === "cap-exhausted") {
        toast("Daily AI limit reached — try again tomorrow.", {
          tone: "error",
        });
      } else {
        toast("Couldn't generate context. Try again later.", { tone: "error" });
      }
    } finally {
      setEnriching(false);
    }
  }

  function onCopyRequest() {
    if (!request) return;
    const text = `${request.title}\n\n${request.body}`;
    void navigator.clipboard?.writeText(text).then(
      () => toast("Catalog request copied.", { tone: "success" }),
      () => toast("Couldn't copy to clipboard.", { tone: "error" })
    );
  }

  return (
    <li
      data-testid="tracked-gap"
      data-covered={gap.covered ? "1" : "0"}
      className={`rounded-lg border px-4 py-3 ${
        gap.covered
          ? "border-emerald-200 bg-emerald-50/50 dark:border-emerald-900 dark:bg-emerald-950/30"
          : "border-slate-200 dark:border-slate-700"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <KindBadge kind={gap.kind} />
          <span className="truncate text-sm font-medium text-slate-900 dark:text-slate-100">
            {gap.label}
          </span>
        </div>
        <button
          type="button"
          onClick={onUntrack}
          disabled={pending}
          data-testid="untrack-gap"
          aria-label="Stop tracking"
          className="shrink-0 text-slate-300 hover:text-rose-500 disabled:opacity-50 dark:text-slate-600"
        >
          <IconX className="h-4 w-4" />
        </button>
      </div>

      {gap.aiDescription ? (
        <div className="mt-3 rounded-md border-l-4 border-l-brand-300 bg-slate-50 px-3 py-2 text-sm text-slate-600 dark:border-l-brand-700 dark:bg-slate-800/50 dark:text-slate-300">
          <p className="leading-relaxed">{gap.aiDescription}</p>
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            AI-generated, unverified — not curated
            {gap.aiSource ? ` · ${gap.aiSource}` : ""}
          </p>
        </div>
      ) : gap.covered ? null : (
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
          No curated context yet. Fill it privately with AI, or request it be
          catalogued.
        </p>
      )}

      {!gap.covered && (
        <div className="mt-3 flex flex-wrap gap-2">
          {aiConfigured && (
            <button
              type="button"
              onClick={onEnrich}
              disabled={enriching}
              data-testid="enrich-gap"
              title={`Generate via ${aiLabel}`}
              className="btn-ghost inline-flex items-center gap-1 text-xs disabled:opacity-50"
            >
              <IconSparkles className="h-3.5 w-3.5" />
              {gap.aiDescription ? "Regenerate context" : "Generate context"}
            </button>
          )}
          <button
            type="button"
            onClick={onCopyRequest}
            data-testid="request-gap"
            className="btn-ghost inline-flex items-center gap-1 text-xs"
          >
            <IconCopy className="h-3.5 w-3.5" /> Copy request
          </button>
          {request && (
            <a
              href={request.issueUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="request-gap-link"
              className="btn-ghost inline-flex items-center gap-1 text-xs"
            >
              <IconExternalLink className="h-3.5 w-3.5" /> Request on GitHub
            </a>
          )}
        </div>
      )}
    </li>
  );
}
