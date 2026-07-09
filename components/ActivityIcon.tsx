// SVG activity icons (Tabler). Resolves a specific icon from the activity title
// via keyword matching, falling back to a generic icon for the activity type.
// Replaces the previous Unicode-emoji icon set.
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

type IconCmp = typeof IconBarbell;

const TYPE_FALLBACK: Record<string, IconCmp> = {
  strength: IconBarbell,
  cardio: IconRun,
  sport: IconMedal2,
};

// Ordered most-specific → most-general; first keyword found in the (lowercased)
// title wins. Order matters (e.g. "table tennis" before "tennis", "skipping"
// before "ski").
const KEYWORD_ICONS: [string[], IconCmp][] = [
  [["table tennis", "ping pong", "ping-pong"], IconPingPong],
  [["ultimate frisbee", "frisbee", "ultimate"], IconDisc],
  [["jump rope", "jump-rope", "skipping"], IconJumpRope],
  [["rock climb", "bouldering", "climbing", "climb"], IconMountain],
  [
    [
      "martial",
      "karate",
      "judo",
      "jiu-jitsu",
      "jiu jitsu",
      "bjj",
      "taekwondo",
      "muay thai",
      "kickbox",
      "boxing",
      "wrestl",
    ],
    IconKarate,
  ],
  [["skateboard"], IconSkateboard],
  [["snowboard"], IconSnowboarding],
  [["skiing", "ski"], IconSkiJumping],
  [["ice skat"], IconIceSkating],
  [["roller skat", "skating", "skate"], IconRollerSkating],
  [["surf"], IconRipple],
  [["rowing", "row"], IconKayak],
  [["kayak", "canoe", "paddle"], IconKayak],
  [["cycling", "bicycle", "biking", "bike", "spin"], IconBike],
  [["swimming", "swim"], IconSwimming],
  [["hiking", "hike", "snowshoe"], IconMountain],
  [["walking", "walk", "ruck"], IconWalk],
  [["treadmill", "running", "run", "jog", "sprint", "trail"], IconRun],
  [["hiit", "interval", "circuit"], IconFlame],
  [["elliptical", "stair"], IconRun],
  [["basketball"], IconBallBasketball],
  [["soccer"], IconBallFootball],
  [["american football", "football"], IconBallAmericanFootball],
  [["baseball", "softball"], IconBallBaseball],
  [["volleyball"], IconBallVolleyball],
  [["badminton"], IconBallTennis],
  [["pickleball"], IconPingPong],
  [["squash", "racquetball", "racquet"], IconBallTennis],
  [["tennis"], IconBallTennis],
  [["golf"], IconGolf],
  [["rugby"], IconBallAmericanFootball],
  [["cricket"], IconBallBaseball],
  [["yoga", "tai chi"], IconYoga],
  [["pilates", "barre", "stretch", "mobility"], IconStretching],
  [["dance", "dancing", "zumba"], IconYoga],
];

function pickIcon(type: string, title?: string): IconCmp {
  if (type === "strength") return IconBarbell;
  const t = (title ?? "").toLowerCase();
  for (const [keys, icon] of KEYWORD_ICONS) {
    if (keys.some((k) => t.includes(k))) return icon;
  }
  return TYPE_FALLBACK[type] ?? IconActivity;
}

export default function ActivityIcon({
  type,
  title,
  className = "h-5 w-5",
  stroke = 1.75,
}: {
  type: string;
  title?: string;
  className?: string;
  stroke?: number;
}) {
  const Icon = pickIcon(type, title);
  return <Icon className={className} stroke={stroke} aria-hidden />;
}
