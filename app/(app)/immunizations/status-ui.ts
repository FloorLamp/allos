// The immunization status pill styling now lives in lib/ so the profile
// passport (a Server Component shared by the authed + public share render) can
// reuse the identical pill (issue #185). Re-exported here so the immunizations
// page + detail view keep their existing `./status-ui` import path.
export {
  STATUS_BADGE,
  STATUS_TEXT,
  statusBadge,
  statusBadgeParts,
} from "@/lib/immunization-status-ui";
