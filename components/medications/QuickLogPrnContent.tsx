import CardSectionHeader from "@/components/CardSectionHeader";
import QuickLogPrnControl from "@/components/medications/QuickLogPrnControl";
import { QuickEntryRowList } from "@/components/quick-entry/QuickEntryRowList";
import type { PrnMedForQuickLog } from "@/lib/queries";
import { now as clockNow } from "@/lib/clock";
import { prnRowStatus } from "@/lib/redose-format";
import type { TimeFormat } from "@/lib/format-date";
import {
  doseUpdateOfferSeat,
  type PediatricFormContext,
} from "@/lib/prn-dosing";

// The quick-log sheet's AS-NEEDED list (#797, reframed by #5753 leg 2). The one-tap
// retro-entry home for PRN medications: each active PRN med gets a one-tap dose control
// plus an "Earlier dose" statement — an absolute time today via the shared WhenControl
// (#2236). The per-day count + last time is computed here (server, with the profile tz)
// and passed down so the client control stays a thin formatter over one server
// computation. The medications page, the dashboard and the illness cockpit compose the
// same `QuickLogPrnControl` inside their own card shells.
//
// ONE FRAME PER BODY. These rows sit in the dose body under one `As needed` eyebrow, in
// the same `QuickEntryRowList` composition the scheduled rows above them use, because a
// bordered card per medication under a list of borderless rows is two designs in one
// sheet (#5521 leg 2). `TodayMedRow`'s inset card is the medications page's and stays
// there.
export default function QuickLogPrnContent({
  meds,
  tz,
  profileId,
  timeFormat,
  nowIso,
  pediatric,
  date,
  onLogged,
}: {
  meds: PrnMedForQuickLog[];
  tz: string;
  profileId?: number;
  timeFormat?: TimeFormat;
  // The redose-window "now", as an ISO instant from the nearest SERVER boundary.
  // REQUIRED whenever this content is mounted under a "use client" parent: in the
  // browser, lib/clock's env override doesn't exist, so a locally-computed now diverges
  // from the clock-stamped recorded_at under ALLOS_TEST_NOW (the frozen e2e clock).
  // Server mounts may omit it (the local clockNow() below is the same server clock).
  nowIso?: string;
  // The SUBJECT's pediatric dosing context (#4713), forwarded to every row so the
  // label band is evaluated at the tap rather than only inside the add form. Absent
  // for an adult profile, and every line below is what it always was.
  pediatric?: PediatricFormContext | null;
  /** The owning quick-log surface's selected day. Other mounts keep their own day. */
  date?: string;
  /** Called after a durable dose write so a retaining host can refresh its row. */
  onLogged?: () => void;
}) {
  // The frozen-clock seam (#1005): recorded_at is stamped through lib/clock, so the
  // elapsed-window "now" must come from the same source (a production no-op). A
  // client-mounted content receives the server's now via nowIso (see prop note).
  const now = nowIso ? new Date(nowIso) : clockNow();
  // The redose status line (#798), when the med has a confirmed interval and
  // something's been logged. Same redoseCardLabel the medications card uses (one
  // computation, so the shared surfaces never disagree). Marker-agnostic — the card
  // always shows current window state regardless of the one-shot notification marker.
  // Family-widened window math (#1027): the clock/count/max span the ingredient
  // family (an OTC ibuprofen dose holds the Rx item's "Redose OK"), with the
  // "across N items" tail marking a cross-item counter.
  // The window math is the shared prnQuickLogRedoseStatus (#221): this content, the
  // medications list and the Telegram `/dose` list all read one gate, so "the
  // interval alone answers when the next dose is OK" can't drift between them.
  // ONE OFFER PER SURFACE (#5538): whichever of this content's rows would first offer
  // to update a stale stored dose gets the seat, and the rest render as they always did.
  const offerSeatId = doseUpdateOfferSeat(
    meds.map((m) => ({ ...m, name: m.displayName ?? m.name })),
    pediatric
  );

  return (
    <div data-testid="quick-log-prn">
      {/* ONE EYEBROW OVER THE WHOLE LIST, not a heading per medication. It is a label
          rather than a link: the sheet is a place to log from, and the page link the
          card version offers would take a reader out of the write they opened. */}
      <CardSectionHeader title="As needed" variant="label" />
      <QuickEntryRowList testId="quick-entry-prn-list">
        {meds.map((m) => {
          const row = prnRowStatus(m, tz, now, timeFormat);
          return (
            <QuickLogPrnControl
              key={m.id}
              itemId={m.id}
              identity={m.identity}
              name={m.displayName ?? m.name}
              doseAmount={m.amount}
              product={m.product}
              dayLabel={row.dayLabel}
              redoseLine={row.redoseLine}
              redosePrimary={row.redosePrimary}
              profileId={profileId}
              rowVariant="quick-entry"
              tz={tz}
              pediatric={pediatric}
              offerSeat={m.id === offerSeatId}
              date={date}
              onLogged={onLogged}
            />
          );
        })}
      </QuickEntryRowList>
    </div>
  );
}
