"use server";

import { requireSession } from "@/lib/auth";
import { searchAll } from "@/lib/queries";
import type { SearchGroup } from "@/lib/search-rank";

// Server action behind the Cmd-K palette's debounced fetch. Resolves the active
// profile from the session (requireSession) and searches ONLY that profile's
// data — never a login's other accessible profiles. Read-only.
export async function runGlobalSearch(query: string): Promise<SearchGroup[]> {
  const { profile } = await requireSession();
  return searchAll(profile.id, query);
}
