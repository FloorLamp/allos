"use client";

import { useState } from "react";
import { IconCircleMinus, IconCircleX } from "@tabler/icons-react";
import OverflowMenu, { MENU_ITEM } from "@/components/OverflowMenu";
import { overridePreventive } from "./actions";

// The override half of a preventive row's controls (issue #82): mark the rule
// "Not applicable" or "Declined" — either hides it. Rebuilt on the shared
// OverflowMenu (issue #281) so it matches every other popover in the app —
// opaque panel, click-away backdrop, Escape — instead of the old translucent
// native-<details> float that never light-dismissed.
export default function PreventiveOverrideMenu({
  ruleKey,
}: {
  ruleKey: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <OverflowMenu
      label="Not applicable or declined"
      open={open}
      onOpenChange={setOpen}
    >
      {({ runAction }) => (
        <>
          <form
            action={(fd) =>
              runAction(overridePreventive, fd, "Marked not applicable")
            }
          >
            <input type="hidden" name="rule_key" value={ruleKey} />
            <input type="hidden" name="kind" value="not_applicable" />
            <button
              type="submit"
              role="menuitem"
              className={`${MENU_ITEM} flex items-center gap-1.5`}
            >
              <IconCircleMinus className="h-3.5 w-3.5" stroke={1.75} />
              Not applicable
            </button>
          </form>
          <form
            action={(fd) =>
              runAction(overridePreventive, fd, "Marked declined")
            }
          >
            <input type="hidden" name="rule_key" value={ruleKey} />
            <input type="hidden" name="kind" value="declined" />
            <button
              type="submit"
              role="menuitem"
              className={`${MENU_ITEM} flex items-center gap-1.5`}
            >
              <IconCircleX className="h-3.5 w-3.5" stroke={1.75} />
              Declined
            </button>
          </form>
        </>
      )}
    </OverflowMenu>
  );
}
