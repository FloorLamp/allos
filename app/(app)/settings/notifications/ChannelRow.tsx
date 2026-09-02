import {
  channelRowLine,
  type ChannelRowState,
} from "@/lib/notifications/delivery-status";
import type { ChannelScope } from "@/lib/notifications/matrix-liveness";
import { formatCompactRelativeTime } from "@/lib/format-date";
import RememberedDetails from "@/components/RememberedDetails";

// ONE ROW OF THE CHANNEL STRIP (#2565 A). The five channel cards that used to stack
// their whole configuration above every other section — 3,050px before the first
// actionable setting at 390px, the worst first-data offset of the app's 90 routes —
// collapse to four rows of: state dot, channel name, one-line status, scope chip,
// chevron. Expanding one reveals that channel's existing controls, unchanged.
//
// IT IS THE APP'S DISCLOSURE, NOT A STRIP WIDGET. `RememberedDetails` (#2652/#3677) is
// a native `<details>`: it opens with JS disabled, in-page find expands it, the keyboard
// semantics are the platform's, and the per-device open memory is the one the settings
// groups already use. So this file adds a SUMMARY, not a fold.
//
// WHY ERRORING PASSES `defaultOpen` AND THE OTHERS DO NOT. RememberedDetails treats an
// explicit `defaultOpen` as caller-controlled: it wins and nothing is remembered for
// that fold. A failing channel is therefore forced open every render while it is
// failing, and — because it remembered nothing — returns to its own remembered state
// the moment it heals, rather than staying open forever because it once broke.
//
// THE DOT IS NOT THE ONLY CARRIER. Colour is not available to everyone and a dot has no
// accessible name at all, so the state WORD opens the visible status line
// (`channelRowLine`) and the dot itself is `aria-hidden`.
export default function ChannelRow({
  channel,
  name,
  scope,
  state,
  blocker,
  profileName,
  children,
}: {
  /** Stable id: the disclosure-memory instance and the row's testid suffix. */
  channel: "telegram" | "push" | "email" | "home-assistant";
  name: string;
  /** Whose setting this row is — the login's username, or the profile's name. */
  scope: string;
  state: ChannelRowState;
  /** Which tier owes the missing setup step, when the row is not set up. */
  blocker: ChannelScope | null;
  profileName: string;
  children: React.ReactNode;
}) {
  const erroring = state.state === "erroring";
  return (
    <RememberedDetails
      id="notify-channel"
      instance={channel}
      defaultOpen={erroring ? true : undefined}
      testId={`notify-channel-${channel}`}
      className="card"
      summary={
        <summary className="flex cursor-pointer list-none items-start gap-3">
          <span
            aria-hidden
            data-testid={`notify-channel-dot-${channel}`}
            data-state={state.state}
            className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[state.state]}`}
          />
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-slate-800 dark:text-slate-100">
                {name}
              </span>
              <span
                data-testid={`notify-channel-scope-${channel}`}
                className="rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-300"
              >
                {scope}
              </span>
            </span>
            <span
              data-testid={`notify-channel-status-${channel}`}
              data-state={state.state}
              className={`mt-0.5 block text-xs ${TEXT[state.state]}`}
            >
              {channelRowLine(state, {
                blocker,
                profileName,
                age: (at) => formatCompactRelativeTime(at),
              })}
            </span>
          </span>
          <span
            aria-hidden
            className="mt-1 shrink-0 text-slate-400 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          >
            ›
          </span>
        </summary>
      }
    >
      <div className="mt-4 space-y-5">{children}</div>
    </RememberedDetails>
  );
}

// Hollow for a channel that cannot reach this owner at all, neutral-filled for one that
// is set up but untried, green for a recorded success, amber for a recorded failure.
const DOT: Record<ChannelRowState["state"], string> = {
  "not-set-up": "border border-slate-300 dark:border-slate-600",
  ready: "bg-slate-400 dark:bg-slate-500",
  delivering: "bg-emerald-500",
  erroring: "bg-amber-500",
};

const TEXT: Record<ChannelRowState["state"], string> = {
  "not-set-up": "text-slate-500 dark:text-slate-400",
  ready: "text-slate-500 dark:text-slate-400",
  delivering: "text-slate-500 dark:text-slate-400",
  erroring: "text-amber-600 dark:text-amber-400",
};
