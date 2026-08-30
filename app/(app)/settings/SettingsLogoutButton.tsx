"use client";

import { useEffect, useRef } from "react";
import { IconLoader2, IconLogout } from "@tabler/icons-react";
import { wipeDeviceForSignOut } from "@/components/device-wipe";
import * as logoutTap from "@/lib/logout-tap";

export default function SettingsLogoutButton() {
  const buttonRef = useRef<HTMLButtonElement>(null);
  async function logout() {
    const button = buttonRef.current;
    if (!button || button.hasAttribute(logoutTap.LOGOUT_PENDING_ATTR)) return;
    button.setAttribute(logoutTap.LOGOUT_PENDING_ATTR, "");
    button.setAttribute("aria-busy", "true");
    await wipeDeviceForSignOut();
    button.form?.requestSubmit();
  }

  useEffect(() => {
    if (logoutTap.hasQueuedLogoutTap(buttonRef.current))
      buttonRef.current?.click();
  }, []);

  return (
    <button
      ref={buttonRef}
      type="button"
      data-testid="settings-logout"
      {...{ [logoutTap.LOGOUT_BUTTON_ATTR]: "" }}
      suppressHydrationWarning
      onClick={() => void logout()}
      data-button-control=""
      className="button-control"
    >
      <IconLogout className="logout-idle-icon h-4 w-4" />
      <IconLoader2
        data-testid="settings-logout-pending"
        className="logout-pending-spinner h-4 w-4 animate-spin motion-reduce:animate-none"
      />
      Log out
    </button>
  );
}
