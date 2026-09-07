// Install navigation observers before Next starts routing. History updates signal
// commits even when the destination URL stays the same; failed reads retain the page.
import { installNavFetchGuard } from "@/lib/nav-fetch-guard";
import { installNavProgress, startNavProgress } from "@/lib/nav-progress";

installNavFetchGuard();
installNavProgress();

export function onRouterTransitionStart(): void {
  startNavProgress();
}
