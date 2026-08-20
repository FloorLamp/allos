// Print the dialog census (#3405).
//
//   npm run census:dialogs            # the whole table
//   npm run census:dialogs -- --hostless   # only the dialogs belonging to no host
//
// USE THIS INSTEAD OF `grep -l 'ModalShell|BottomSheet'` when you sweep this
// family. That grep matches a FILENAME's contents for a string, which is a
// cheaper question than "does this component use the host": it counted a file
// that only NAMES ModalShell in a comment, and it cannot see a dialog that
// hand-rolls its own surface. The rule and the receipts are in
// lib/dialog-census.ts.
//
// READ-ONLY. It reads source files and touches nothing.

import {
  censusRepoDialogs,
  HOSTLESS_DIALOGS,
  HOST_MODULES,
  type DialogEntry,
} from "../lib/dialog-census";

const log = (line = "") => {
  // eslint-disable-next-line no-console
  console.log(line);
};

function facts(entry: DialogEntry): string {
  const h = entry.handRolled;
  if (h == null) return "";
  const bits: string[] = [];
  bits.push(h.portal ? "own portal" : "no portal (inline)");
  if (h.ownFullViewportLayer) bits.push("own fixed inset-0");
  bits.push(h.sharedFocusTrap ? "shared focus trap" : "own focus behaviour");
  if (h.sharedBodyLock) bits.push("shared body lock");
  if (h.sharedOverlayPrimitives) bits.push("shared overlay primitives");
  if (h.ownEscapeHandler) bits.push("own Escape handler");
  if (h.ownScroller)
    bits.push(
      h.overscrollContained
        ? "own scroller (overscroll contained)"
        : "own scroller (overscroll NOT contained)"
    );
  return bits.join(", ");
}

function main() {
  const onlyHostless = process.argv.includes("--hostless");
  const census = censusRepoDialogs();

  log(`source files read: ${census.filesScanned}`);
  log();

  if (!onlyHostless) {
    log(`HOSTS (${census.hosts.length})`);
    for (const entry of census.hosts) {
      log(`  ${entry.rel}`);
      log(`      ${HOST_MODULES[entry.rel]}`);
    }
    log();

    log(`HOSTED — renders a dialog through a host (${census.hosted.length})`);
    for (const entry of census.hosted) {
      log(`  ${entry.rel}  <- ${entry.via.join(", ")}`);
    }
    log();

    log(
      `CONFIRM CALLERS — reach the one provider-mounted confirm by hook, not by ` +
        `rendering a surface (${census.confirmCallers.length})`
    );
    for (const entry of census.confirmCallers) {
      log(`  ${entry.rel}  <- ${entry.via.join(", ")}`);
    }
    log();
  }

  log(
    `HOSTLESS — a dialog belonging to NO DIALOG host (${census.hostless.length})`
  );
  for (const entry of census.hostless) {
    log(`  ${entry.rel}`);
    log(`      ${facts(entry)}`);
    const note = HOSTLESS_DIALOGS[entry.rel];
    log(`      ${note ?? "*** NOT RECORDED in HOSTLESS_DIALOGS ***"}`);
  }
  log();

  if (census.unrecordedHostless.length > 0) {
    log(`UNRECORDED (the guard fails on these):`);
    for (const rel of census.unrecordedHostless) log(`  ${rel}`);
    log();
  }
  if (census.staleRecords.length > 0) {
    log(`STALE RECORDS (recorded but no longer hostless):`);
    for (const rel of census.staleRecords) log(`  ${rel}`);
    log();
  }

  log(
    `totals: ${census.hosts.length} hosts, ${census.hosted.length} hosted, ` +
      `${census.confirmCallers.length} confirm callers, ` +
      `${census.hostless.length} hostless`
  );
}

main();
