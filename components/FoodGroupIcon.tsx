// SVG food-group icons (Tabler). Resolves a food group's slug to a specific
// icon via the pure key map in lib/food-group-icon.ts, falling back to a generic
// food glyph for a retired/unknown slug. The ONE component every food surface
// (log bar, weekly rollup, habits card, suggestion track buttons) renders, so
// the glyphs can't drift per surface — the components/ActivityIcon.tsx precedent.
import {
  IconApple,
  IconBottle,
  IconBowl,
  IconBread,
  IconBurger,
  IconCandy,
  IconCarrot,
  IconCherry,
  IconDroplet,
  IconEgg,
  IconFish,
  IconGlassCocktail,
  IconGlassFull,
  IconLeaf,
  IconMeat,
  IconMilk,
  IconPlant2,
  IconSausage,
  IconSeeding,
  IconSoup,
  IconToolsKitchen2,
  IconWheat,
} from "@tabler/icons-react";
import { foodGroupIconKey, type FoodGroupIconKey } from "@/lib/food-group-icon";

type IconCmp = typeof IconFish;

const KEY_ICONS: Record<FoodGroupIconKey, IconCmp> = {
  fish: IconFish,
  leaf: IconLeaf,
  plant: IconPlant2,
  carrot: IconCarrot,
  soup: IconSoup,
  seeding: IconSeeding,
  grain: IconWheat,
  apple: IconApple,
  cherry: IconCherry,
  bottle: IconBottle,
  meat: IconMeat,
  egg: IconEgg,
  milk: IconMilk,
  bowl: IconBowl,
  droplet: IconDroplet,
  sausage: IconSausage,
  bread: IconBread,
  burger: IconBurger,
  candy: IconCandy,
  glass: IconGlassFull,
  cocktail: IconGlassCocktail,
  generic: IconToolsKitchen2,
};

export default function FoodGroupIcon({
  slug,
  className = "h-5 w-5",
  stroke = 1.75,
}: {
  // The food-group catalog slug (food_log.group_key).
  slug: string;
  className?: string;
  stroke?: number;
}) {
  const key = foodGroupIconKey(slug);
  const Icon = KEY_ICONS[key];
  return (
    <Icon
      className={className}
      stroke={stroke}
      aria-hidden
      data-testid="food-group-icon"
      data-icon={key}
    />
  );
}
