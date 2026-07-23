# Import & document actions — the canonical verb vocabulary

Status: **shipped** (#1071)

The document/import surfaces used to carry a thicket of near-synonym verbs —
"Reprocess" / "Re-extract" / "Re-import" — for operations whose real distinction
(re-run the AI vs replay the saved result vs batch vs preview-first) was invisible,
plus two contradictory "Reprocess" controls on one page (one preview-first and
safe, one fire-and-replace and destructive). Issue #1071 consolidated them: **one
verb per operation, labelled by the attribute that differs** (#531/#534), and the
safe preview-first flow is the ONLY per-document reprocess.

This note is the source of truth for those verbs so the next surface reuses them
instead of coining a fifth synonym.

## Canonical verbs

| Verb                                   | Where                                                  | What it does                                                                                                                                        | AI call?                                                                                     | Writes?           |
| -------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ----------------- |
| **Preview changes**                    | import detail (`ReprocessDiffPanel`)                   | Read-only: re-extracts to an in-memory shape and shows the diff vs the persisted rows. Never writes.                                                | yes (offline: reports it can't, offers "Re-extract anyway")                                  | no                |
| **Save changes**                       | import detail (`ReprocessDiffPanel`, after a preview)  | Commits EXACTLY the previewed extraction (#946); replaces the document's rows. Disabled when the preview shows no changes.                          | no (replays the previewed input; falls back to a fresh re-extract only if the token expired) | yes               |
| **Re-extract anyway**                  | import detail (`ReprocessDiffPanel`, "skipped" branch) | Override for the content-hash short-circuit ("we didn't run it") — forces a fresh AI re-extraction.                                                 | yes                                                                                          | yes               |
| **Re-apply saved extraction**          | import detail (`ImportDetailActions`)                  | Replays the AI extraction already saved with the document — no model call, no quota. The fix when the extraction was fine but the import was wrong. | no                                                                                           | yes               |
| **Re-run extraction on all documents** | Imports feed header (`ReprocessButton`, #208)          | Batch: re-extracts every uploaded document (deterministic re-import for health records, AI for scans/PDFs). Previews the AI cost before confirming. | some                                                                                         | yes               |
| **Delete document & its records**      | import detail (`ImportDetailActions`)                  | Removes the document and every row it imported. Confirms; the confirm names the full scope.                                                         | no                                                                                           | yes (destructive) |
| **Discard**                            | Import tab (`ImportClient`, paste-job card)            | Drops an UNcommitted paste/CSV extraction job — nothing was persisted yet.                                                                          | no                                                                                           | no (job only)     |

## The two rules this consolidation enforces

1. **A control says exactly what happens.** "Preview changes" never writes; the
   button that writes is "Save changes". There is no button labelled "Reprocess"
   that is secretly a read (the pre-#1071 bug), and no immediate fire-and-replace
   twin of the preview flow (`ExtractedRecords`' old reprocess icon was removed —
   the sole per-document reprocess is the preview→save pair).

2. **The no-change preview disables the commit.** When a fresh re-extraction would
   change nothing, the preview says so as the headline ("Re-extraction produced
   identical results — nothing to save.") and "Save changes" is disabled — a user
   can never commit a pointless full row-replacement of identical content. The
   decision is the pure `reprocessPreviewView` (`lib/reprocess-preview-view.ts`),
   unit-tested since the ok/no-change branch isn't reachable in the extractor-less
   e2e env. This is distinct from the "skipped" (content-hash) case, which DID not
   run and keeps its "Re-extract anyway" override.

## Raw views go through one component (#1318)

Every raw payload / raw-extraction surface renders through the shared
`components/RawDataViewer.tsx` — never a bare `<pre>` dump. It sniffs JSON vs XML vs
plain text once (`lib/raw-data-tree.ts`, pure) and renders JSON and XML through the
SAME collapsible tree (two node adapters over one fold/depth/a11y machinery, #221),
with copy-the-full-text, a depth default, and a size guard; anything that parses as
neither (incl. a DOMParser `parsererror`) is the plain-text last resort. Consumers:
the import-detail **Raw extraction** disclosure and the admin **`RawPayloadViewer`**
(sync-event payloads). Gating stays with the callers — the viewer is
presentation-only. A new raw surface reuses it instead of hand-rolling another
`<pre>`.

## One home per document

An uploaded document has ONE action home — its **import detail** page
(`/import/<id>`), reached from Data → **Review**. It does not appear as a peer row
on the Import tab (that tab carries paste/CSV jobs, the integrations grid, and a
link to Review). The footer "Import history & review →" link and the profile-menu
badge both point at the Review tab; "Review" means the tab, one destination.
