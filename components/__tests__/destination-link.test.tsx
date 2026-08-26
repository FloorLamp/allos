import { expect, it } from "vitest";
import DestinationLink, {
  DestinationActionLink,
  StandingDestinationLink,
} from "@/components/DestinationLink";

it("keeps destination props while rejecting native titles", () => {
  type LinkProps = Parameters<typeof DestinationLink>[0];
  type ActionProps = Parameters<typeof DestinationActionLink>[0];
  type StandingProps = Parameters<typeof StandingDestinationLink>[0];

  const acceptsLink = (props: LinkProps) => props.href;
  const acceptsAction = (props: ActionProps) => props.href;
  const acceptsStanding = (props: StandingProps) => props.href;

  expect(
    acceptsLink({ href: "/trends", prefetch: false, children: "Trends" })
  ).toBe("/trends");
  expect(
    acceptsAction({ href: "/upcoming", replace: true, children: "Upcoming" })
  ).toBe("/upcoming");
  expect(
    acceptsStanding({
      href: "/trends",
      scroll: false,
      destinationLabel: "Dashboard",
      children: "Standing",
    })
  ).toBe("/trends");

  // @ts-expect-error DestinationLink owns disclosure and does not accept titles.
  acceptsLink({ href: "/trends", title: "Trends", children: "Trends" });
  // @ts-expect-error DestinationActionLink owns disclosure and does not accept titles.
  acceptsAction({ href: "/upcoming", title: "Upcoming", children: "Upcoming" });
  acceptsStanding({
    href: "/trends",
    // @ts-expect-error StandingDestinationLink owns disclosure and does not accept titles.
    title: "Dashboard",
    destinationLabel: "Dashboard",
    children: "Standing",
  });
});
