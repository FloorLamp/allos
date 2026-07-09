// SVG activity icons (Tabler). Resolves a specific icon from the activity's
// structured component/sport names and free-text title via keyword matching
// (pure logic in lib/activity-icon.ts), falling back to a generic icon for the
// activity type. Replaces the previous Unicode-emoji icon set.
import {
  IconActivity,
  IconBallAmericanFootball,
  IconBallBaseball,
  IconBallBasketball,
  IconBallFootball,
  IconBallTennis,
  IconBallVolleyball,
  IconBarbell,
  IconBike,
  IconDisc,
  IconFlame,
  IconGolf,
  IconIceSkating,
  IconJumpRope,
  IconKarate,
  IconKayak,
  IconMedal2,
  IconMountain,
  IconPingPong,
  IconRipple,
  IconRollerSkating,
  IconRun,
  IconSkateboard,
  IconSkiJumping,
  IconSnowboarding,
  IconStretching,
  IconSwimming,
  IconWalk,
  IconYoga,
} from "@tabler/icons-react";
import { pickActivityIconKey, type ActivityIconKey } from "@/lib/activity-icon";

type IconCmp = typeof IconBarbell;

const KEY_ICONS: Record<ActivityIconKey, IconCmp> = {
  barbell: IconBarbell,
  run: IconRun,
  medal: IconMedal2,
  activity: IconActivity,
  "ping-pong": IconPingPong,
  disc: IconDisc,
  "jump-rope": IconJumpRope,
  mountain: IconMountain,
  karate: IconKarate,
  skateboard: IconSkateboard,
  snowboard: IconSnowboarding,
  ski: IconSkiJumping,
  "ice-skate": IconIceSkating,
  "roller-skate": IconRollerSkating,
  surf: IconRipple,
  kayak: IconKayak,
  bike: IconBike,
  swim: IconSwimming,
  walk: IconWalk,
  flame: IconFlame,
  basketball: IconBallBasketball,
  soccer: IconBallFootball,
  "american-football": IconBallAmericanFootball,
  baseball: IconBallBaseball,
  volleyball: IconBallVolleyball,
  tennis: IconBallTennis,
  golf: IconGolf,
  yoga: IconYoga,
  stretch: IconStretching,
};

export default function ActivityIcon({
  type,
  title,
  sportNames,
  className = "h-5 w-5",
  stroke = 1.75,
}: {
  type: string;
  title?: string;
  // Structured component/sport names (e.g. Strava's canonical "Cycling"),
  // matched before the free-text title so an imported "Morning Ride" icons as a
  // bike rather than falling back to the generic cardio (run) icon.
  sportNames?: string[];
  className?: string;
  stroke?: number;
}) {
  const key = pickActivityIconKey(type, title, sportNames);
  const Icon = KEY_ICONS[key];
  return (
    <Icon
      className={className}
      stroke={stroke}
      aria-hidden
      data-testid="activity-icon"
      data-icon={key}
    />
  );
}
