// ---- Settings tiers ----
// Three key/value stores. `settings` is app-global (bot token, migration flags,
// instance defaults). `profile_settings` is per tracked person (sex, timezone,
// notification schedule, active situations). `login_settings` is per login
// identity (unit display preferences). Convert at the boundary: a query/action
// resolves the right tier from the session's profile/login id.
//
// This module is a thin re-export BARREL (the #126 pattern, mirroring lib/queries):
// the implementation lives in domain modules under lib/settings/, but everything is
// re-exported here so `@/lib/settings` import paths and export names are unchanged.
//   - kv.ts             the three-tier get/set/delete primitives
//   - display.ts        unit prefs, timezone (per profile), week start/mode,
//                       trend pins/views, dashboard layout
//   - server.ts         public URL, instance timezone, backup, audit retention, AI
//   - notifications.ts  telegram bot config, per-profile telegram, HA channel,
//                       chat-id lookup, notify schedule
//   - profile-attrs.ts  sex/reproductive/smoking/name/birthdate/age/max-HR/zone-2,
//                       metric source priority, emergency card/contact/blood type,
//                       active situations, extraction adoption
//   - calendar-feed.ts  per-profile + consolidated (per-login) .ics feed tokens

// Re-exported for API compatibility: these historically lived in lib/settings and
// callers across app/ import them from here. The implementation now lives in the
// db-free lib/timezone module, shared with lib/db's day-boundary reader.
export { DEFAULT_TIMEZONE, isValidTimezone } from "./timezone";

export * from "./settings/kv";
export * from "./settings/display";
export * from "./settings/location";
export * from "./settings/server";
export * from "./settings/notifications";
export * from "./settings/profile-attrs";
export * from "./settings/calendar-feed";
