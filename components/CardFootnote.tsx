import type { HTMLAttributes } from "react";

type CardFootnoteProps = Omit<
  HTMLAttributes<HTMLParagraphElement>,
  "className"
> & {
  divided?: boolean;
};

// Supporting copy at the end of a card. The divider keeps it attached to the
// card while separating it from the primary content; `divided={false}` is for a
// note that is the card's only content.
export default function CardFootnote({
  divided = true,
  ...props
}: CardFootnoteProps) {
  return (
    <p
      {...props}
      className={`${divided ? "card-footnote mt-4 border-t border-black/5 bg-black/2.5 pt-3 dark:border-white/10 dark:bg-white/2.5" : ""} text-xs leading-relaxed text-slate-500 dark:text-slate-400`}
    />
  );
}
