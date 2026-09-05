import { useFormStatus } from "react-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ConfirmProvider, useConfirm } from "@/components/ConfirmDialog";

// A `confirm()` awaited INSIDE a `<form action>` must still put its sheet on
// screen (#5336). This is not a style question about where to ask: a form action
// runs as a React transition, and React holds every `useState` update scheduled
// inside a pending async action until that action settles. When the thing the
// held update would render is the sheet the action is waiting on, neither side
// can go first — components/IntakeItemForm.tsx hung on "Saving…" forever, with
// no sheet and no error, for every Must -> Should/May medication edit.
//
// So the provider reads its pending request from an external store
// (`useSyncExternalStore`), which React may not defer. These two cases are what
// that buys, and they are the reason not to move the confirm out of the action:
// the seam is the provider's, and no future caller has to know about it.
function ConfirmingForm({ record }: { record: (ok: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <form
      action={async () => {
        record(
          await confirm({
            title: "Reduce reminders for Ibuprofen?",
            confirmLabel: "Reduce reminders",
          })
        );
      }}
    >
      <Saving />
      <button type="submit">Save</button>
    </form>
  );
}

// The form's own pending flag, the one components/SubmitButton.tsx reads. It is
// what showed "Saving…" with nothing to answer, so the tests assert the sheet is
// on screen WHILE it says so — a sheet that only arrives after the action
// settles would be no fix at all.
function Saving() {
  return useFormStatus().pending ? <p>Saving…</p> : null;
}

describe("a confirm awaited inside a form action", () => {
  it.each([
    ["Reduce reminders", true],
    ["Cancel", false],
  ])("renders its sheet, and %s resolves the await to %s", async (label, ok) => {
    const answers: boolean[] = [];
    render(
      <ConfirmProvider>
        <ConfirmingForm record={(a) => answers.push(a)} />
      </ConfirmProvider>
    );

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    // The sheet, while the action is still pending on it.
    await screen.findByTestId("confirm-dialog");
    expect(screen.getByText("Saving…")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: label }));

    // Answering lets the action continue, and it carries the answer.
    await waitFor(() => expect(answers).toEqual([ok]));
    await waitFor(() => expect(screen.queryByText("Saving…")).toBeNull());
  });
});
