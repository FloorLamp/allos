"use client";

import { useEffect, useRef } from "react";
import { IconX } from "@tabler/icons-react";
import { LG_QUERY } from "./mobileDetail";
import { useHistoryBackClose } from "./useHistoryBackClose";
import { useLockBodyScroll } from "./useLockBodyScroll";

// A mobile-only (`lg:hidden`) full-page detail surface for master/detail views.
// On desktop the Explorer pages and the journal show the detail beside the
// list; on mobile the list can be long, so a tapped row's detail takes over the
// screen as its own page (like the activity editor) instead of appearing far
// below it. Callers open it only on mobile (openDetailOnMobile); it also closes
// itself if the viewport grows to the desktop breakpoint.
export default function MobileDetailPage({
  open,
  onClose,
  title,
  children,
  desktopAt = "lg",
}: {
  open: boolean;
  onClose: () => void;
  // Shown in the fixed header beside the ✕, so the name stays visible while
  // the content scrolls. The detail panels hide their own inline name below lg
  // to avoid repeating it.
  title?: React.ReactNode;
  children: React.ReactNode;
  // Journal needs more room for its two-column editor/detail layout than the
  // other master-detail surfaces, so it promotes at xl instead of lg.
  desktopAt?: "lg" | "xl";
}) {
  // Callers pass an inline onClose; keep the latest in a ref so the effects
  // below run once per open/close instead of on every parent render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCloseRef.current();
    };
    const mq = window.matchMedia(
      desktopAt === "xl" ? "(min-width: 1280px)" : LG_QUERY
    );
    const onDesktop = () => {
      if (mq.matches) onCloseRef.current();
    };
    document.addEventListener("keydown", onKey);
    mq.addEventListener("change", onDesktop);
    return () => {
      document.removeEventListener("keydown", onKey);
      mq.removeEventListener("change", onDesktop);
    };
  }, [open, desktopAt]);

  useLockBodyScroll(open);

  // Reading as its own page, it holds a history entry while open so the phone's
  // back button/gesture closes it.
  const markLinkFollowed = useHistoryBackClose(open, onClose);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className={`fixed inset-0 z-50 flex flex-col bg-white pt-[env(safe-area-inset-top)] dark:bg-ink-900 ${
        desktopAt === "xl" ? "xl:hidden" : "lg:hidden"
      }`}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-black/5 py-2 pl-4 pr-2 dark:border-white/10">
        <h2 className="min-w-0 truncate font-semibold text-slate-800 dark:text-slate-100">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-600 dark:text-slate-400 dark:hover:bg-ink-800 dark:hover:text-slate-300"
        >
          <IconX className="h-5 w-5" />
        </button>
      </div>
      {/* Detail panels contain links (recent sessions, goals) that navigate the
          page underneath. Close the takeover so the navigation is visible, and
          leave the history entry unconsumed — a compensating back() mid-
          navigation could undo the navigation itself. */}
      <div
        className="flex-1 overflow-y-auto overscroll-contain px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]"
        onClickCapture={(e) => {
          if ((e.target as Element).closest("a[href]")) {
            markLinkFollowed();
            onClose();
          }
        }}
      >
        {children}
      </div>
    </div>
  );
}
