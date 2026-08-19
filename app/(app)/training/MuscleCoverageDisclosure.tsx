"use client";

import type {
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  ReactNode,
} from "react";
import { createContext, useContext } from "react";

const TARGET_SELECTOR = "[data-muscle-target], [data-coverage-row-target]";
const ACTIVITY_SELECTOR = "[data-activity-muscles]";
const SOURCE_SELECTOR = `${TARGET_SELECTOR}, ${ACTIVITY_SELECTOR}`;
const MuscleCoverageDisclosureContext = createContext(false);

function targetFor(element: Element): string | null {
  return (
    element.getAttribute("data-muscle-target") ??
    element.getAttribute("data-coverage-row-target")
  );
}

function sourceElementFor(source: EventTarget | null): Element | null {
  return source instanceof Element ? source.closest(SOURCE_SELECTOR) : null;
}

function targetsFor(source: EventTarget | null): string[] {
  const element = sourceElementFor(source);
  if (!element) return [];
  const activityMuscles = element.getAttribute("data-activity-muscles");
  if (activityMuscles) {
    return activityMuscles
      .split(" ")
      .filter(Boolean)
      .map((muscle) => `coverage-${muscle}`);
  }
  const target = targetFor(element);
  return target ? [target] : [];
}

export default function MuscleCoverageDisclosure({
  children,
}: {
  children: ReactNode;
}) {
  const disclosureAlreadyManaged = useContext(MuscleCoverageDisclosureContext);

  // The detail page coordinates exercise rows and the coverage card through one
  // page-level disclosure. The card also owns this behavior when rendered alone
  // on Overview, so nested instances deliberately defer to their nearest owner.
  if (disclosureAlreadyManaged) return children;

  function expandRow(container: HTMLDivElement, control: Element) {
    const target = control.getAttribute("data-muscle-target");
    if (!target) return;
    const row = document.getElementById(target);
    if (!row || !container.contains(row)) return;
    const disclosure = row.querySelector("details");
    if (disclosure) disclosure.open = true;
    row.scrollIntoView({ block: "nearest" });
  }

  function setHighlighted(
    container: HTMLDivElement,
    targets: string[],
    activitySource: Element | null
  ) {
    const active = new Set(targets);
    for (const element of container.querySelectorAll(SOURCE_SELECTOR)) {
      const activityMuscles = element.getAttribute("data-activity-muscles");
      const highlighted = activityMuscles
        ? activitySource
          ? element === activitySource
          : activityMuscles
              .split(" ")
              .some((muscle) => active.has(`coverage-${muscle}`))
        : active.has(targetFor(element) ?? "");
      if (highlighted) element.setAttribute("data-highlighted", "true");
      else element.removeAttribute("data-highlighted");
    }
  }

  function highlightFrom(
    container: HTMLDivElement,
    source: EventTarget | null
  ) {
    const sourceElement = sourceElementFor(source);
    const targets = targetsFor(source);
    if (targets.length > 0) {
      setHighlighted(
        container,
        targets,
        sourceElement?.hasAttribute("data-activity-muscles")
          ? sourceElement
          : null
      );
    }
  }

  function clearFrom(
    container: HTMLDivElement,
    source: EventTarget | null,
    destination: EventTarget | null
  ) {
    if (targetsFor(source).length === 0) return;
    const destinationElement = sourceElementFor(destination);
    setHighlighted(
      container,
      targetsFor(destination),
      destinationElement?.hasAttribute("data-activity-muscles")
        ? destinationElement
        : null
    );
  }

  function onClick(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest("[data-muscle-target]");
    if (control) expandRow(event.currentTarget, control);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    if (!(event.target instanceof Element)) return;
    const control = event.target.closest("[data-muscle-target]");
    if (!control) return;
    event.preventDefault();
    expandRow(event.currentTarget, control);
  }

  return (
    <MuscleCoverageDisclosureContext.Provider value>
      <div
        onClick={onClick}
        onKeyDown={onKeyDown}
        onPointerOver={(event: PointerEvent<HTMLDivElement>) =>
          highlightFrom(event.currentTarget, event.target)
        }
        onPointerOut={(event: PointerEvent<HTMLDivElement>) =>
          clearFrom(event.currentTarget, event.target, event.relatedTarget)
        }
        onFocus={(event: FocusEvent<HTMLDivElement>) =>
          highlightFrom(event.currentTarget, event.target)
        }
        onBlur={(event: FocusEvent<HTMLDivElement>) =>
          clearFrom(event.currentTarget, event.target, event.relatedTarget)
        }
      >
        {children}
      </div>
    </MuscleCoverageDisclosureContext.Provider>
  );
}
