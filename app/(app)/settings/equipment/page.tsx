import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// Equipment moved out of Settings into its own top-level registry (issue #343):
// a domain inventory with per-item detail + usage history, not configuration.
// This route only survives as a redirect for old bookmarks / deep links — the
// repo defines no next.config redirects, so the bounce is a route-level
// redirect() here. The age gate (a restricted profile can't reach equipment) now
// lives on the /equipment page itself.
export default function EquipmentSettingsRedirect() {
  redirect("/equipment");
}
