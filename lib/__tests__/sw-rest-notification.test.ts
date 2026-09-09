import fs from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { KIND_CADENCE } from "@/lib/notifications/cadence-registry";

const source = fs.readFileSync(
  fileURLToPath(new URL("../../public/sw.js", import.meta.url)),
  "utf8"
);

function worker() {
  const listeners = new Map<string, (event: unknown) => void>();
  const unrelated = {
    id: "other-tab",
    type: "window",
    focus: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
  };
  const origin = {
    id: "rest-tab",
    type: "window",
    focus: vi.fn(async () => {}),
    navigate: vi.fn(async () => {}),
  };
  const clients = {
    get: vi.fn(async (id: string): Promise<typeof origin | undefined> =>
      id === origin.id ? origin : undefined
    ),
    matchAll: vi.fn(async () => [unrelated, origin]),
    openWindow: vi.fn(async () => {}),
  };
  const showNotification = vi.fn(
    async (_title: string, _options: NotificationOptions) => {}
  );
  vm.runInNewContext(source, {
    URL,
    self: {
      location: new URL("https://allos.example.test/sw.js?v=fixture"),
      registration: { showNotification },
      clients,
      addEventListener: (name: string, callback: (event: unknown) => void) =>
        listeners.set(name, callback),
    },
  });
  const dispatch = async (name: string, event: object) => {
    const pending: Promise<unknown>[] = [];
    listeners.get(name)?.({
      ...event,
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    await Promise.all(pending);
  };
  const message = (
    sender: object | null = {
      id: origin.id,
      type: "window",
      url: "https://allos.example.test/training?tab=log",
    }
  ) =>
    dispatch("message", {
      source: sender,
      // None of these caller-controlled fields may reach the notification.
      data: {
        type: "allos-rest-done",
        clientId: unrelated.id,
        title: "Synthetic lift",
        body: "Synthetic load",
        url: "/wrong-route",
      },
    });
  const click = async (data: object) => {
    const close = vi.fn();
    await dispatch("notificationclick", { notification: { data, close } });
    expect(close).toHaveBeenCalledOnce();
  };
  return {
    clients,
    origin,
    unrelated,
    showNotification,
    message,
    click,
    dispatch,
  };
}

describe("rest notifications in the actual service worker", () => {
  it("displays only fixed rest content and focuses the actual originating tab without navigation", async () => {
    const w = worker();
    await w.message();
    expect(w.showNotification.mock.calls).toEqual([
      [
        "Rest done",
        {
          body: "",
          icon: "/icon.svg",
          badge: "/icon.svg",
          data: { type: "allos-rest-done", clientId: "rest-tab" },
        },
      ],
    ]);
    const data = w.showNotification.mock.calls[0][1].data;
    // The displayed device alarm is not a health-notification cadence family.
    expect(Object.keys(KIND_CADENCE)).not.toContain(data.type);
    await w.click(data);
    expect(w.clients.get).toHaveBeenCalledWith("rest-tab");
    expect(w.origin.focus).toHaveBeenCalledOnce();
    expect(w.origin.navigate).not.toHaveBeenCalled();
    expect(w.unrelated.focus).not.toHaveBeenCalled();
    expect(w.unrelated.navigate).not.toHaveBeenCalled();
    expect(w.clients.openWindow).not.toHaveBeenCalled();
  });

  it("opens Training when the originating tab vanished, leaving another open tab alone", async () => {
    const w = worker();
    w.clients.get.mockResolvedValue(undefined);
    await w.click({ type: "allos-rest-done", clientId: "closed-tab" });
    expect(w.clients.openWindow).toHaveBeenCalledWith("/training");
    expect(w.unrelated.focus).not.toHaveBeenCalled();
    expect(w.unrelated.navigate).not.toHaveBeenCalled();
  });

  it("ignores non-app message senders and absorbs rejected display/focus attempts", async () => {
    const w = worker();
    for (const sender of [
      null,
      { id: "worker", type: "worker", url: "https://allos.example.test/" },
      { id: "outside", type: "window", url: "https://outside.example.test/" },
    ])
      await w.message(sender);
    expect(w.showNotification).not.toHaveBeenCalled();
    w.showNotification.mockRejectedValueOnce(new Error("Display denied"));
    await expect(w.message()).resolves.toBeUndefined();
    expect(w.showNotification).toHaveBeenCalledOnce();
    w.origin.focus.mockRejectedValueOnce(new Error("Focus denied"));
    await expect(
      w.click({ type: "allos-rest-done", clientId: w.origin.id })
    ).resolves.toBeUndefined();
    expect(w.clients.openWindow).not.toHaveBeenCalled();
    expect(w.origin.navigate).not.toHaveBeenCalled();
  });

  it("retains ordinary push content and its existing focus/deep-link navigation", async () => {
    const w = worker();
    await w.dispatch("push", {
      data: {
        json: () => ({
          title: "Allos reminder",
          body: "Synthetic reminder",
          url: "/history",
        }),
      },
    });
    expect(w.showNotification.mock.calls).toEqual([
      [
        "Allos reminder",
        {
          body: "Synthetic reminder",
          icon: "/icon.svg",
          badge: "/icon.svg",
          data: { url: "/history" },
        },
      ],
    ]);
    await w.click(w.showNotification.mock.calls[0][1].data);
    expect(w.clients.matchAll).toHaveBeenCalledWith({
      type: "window",
      includeUncontrolled: true,
    });
    expect(w.unrelated.focus).toHaveBeenCalledOnce();
    expect(w.unrelated.navigate).toHaveBeenCalledWith("/history");
    expect(w.clients.get).not.toHaveBeenCalled();
  });
});
