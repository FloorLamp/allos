// Compatibility boundary for the shipped Now-strip API (#1413).
//
// Dashboard placement now has one owner: lib/dashboard-relevance.ts (#3080).
// Keep these exports stable so existing callers and the unmodified behavior
// suite continue to pin the original clock-window contract.
export {
  DEFAULT_WAKE_MINUTES,
  MEAL_WINDOW_MIN,
  NOW_CARD_IDS,
  NOW_STRIP_CAP,
  WAKE_WINDOW_MIN,
  rankNowCards,
  type NowCardId,
  type NowSignals,
} from "./dashboard-relevance";
