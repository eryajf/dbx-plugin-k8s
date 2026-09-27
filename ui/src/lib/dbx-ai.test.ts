import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import i18n from "@/i18n";

import {
  dbxAIPage,
  dbxAIRecommendations,
  openDBXAIConversation,
  useDBXRecommendations,
} from "./dbx-ai";

describe("dbxAIPage", () => {
  it("maps overview and namespaced resource routes", () => {
    expect(dbxAIPage("/dashboard")).toEqual({ route: "/dashboard" });
    expect(dbxAIPage("/pods/default/demo")).toEqual({
      route: "/pods/default/demo",
      resource: "pods",
      namespace: "default",
      name: "demo",
    });
  });
});

afterEach(cleanup);

describe("host recommendations", () => {
  it("reuses translated resource scenes with safe host placeholders and five-item limit", async () => {
    await i18n.changeLanguage("zh-CN");
    expect(dbxAIRecommendations(dbxAIPage("/"))).toHaveLength(5);
    expect(dbxAIRecommendations(dbxAIPage("/deployments"))[0].prompt).toContain(
      "rollout",
    );
    expect(
      dbxAIRecommendations(dbxAIPage("/pods/ns/demo"))[0].prompt,
    ).toContain("{{resource.name}}");
    expect(dbxAIPage("/crds/widgets/example")).toEqual({
      route: "/crds/widgets/example",
      resource: "widgets",
      name: "example",
    });
    expect(dbxAIPage("/crds/widgets.example.com")).toEqual({
      route: "/crds/widgets.example.com",
      resource: "widgets.example.com",
    });
  });

  it("publishes the latest snapshot only when navigation races an old request", async () => {
    let resolveOld!: (value: unknown) => void;
    const invoke = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValue({ schemaVersion: 1, data: { current: true } });
    const setRecommendations = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "dbxPlugin", {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        context: { connectionId: "cluster-a" },
        capabilities: { ai: true, aiRecommendations: true },
        invoke,
        ai: { setRecommendations },
      },
    });
    const { rerender, unmount } = renderHook(
      ({ path }) => useDBXRecommendations(dbxAIPage(path)),
      { initialProps: { path: "/pods/ns/old" } },
    );
    await waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    rerender({ path: "/deployments/ns/new" });
    await waitFor(() =>
      expect(setRecommendations).toHaveBeenLastCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            resource: { kind: "deployment", namespace: "ns", name: "new" },
            data: { current: true },
            connectionId: "cluster-a",
          }),
          items: expect.arrayContaining([
            expect.objectContaining({ id: "deploymentDetail-releaseCheck" }),
          ]),
        }),
      ),
    );
    await act(async () => resolveOld({ data: { obsolete: true } }));
    expect(JSON.stringify(setRecommendations.mock.calls)).not.toContain(
      "obsolete",
    );
    unmount();
  });

  it("keeps route recommendations when snapshot retrieval fails", async () => {
    const setRecommendations = vi.fn().mockResolvedValue(undefined);
    const openConversation = vi.fn();
    Object.defineProperty(window, "dbxPlugin", {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        context: { connectionId: "cluster-a" },
        capabilities: { aiRecommendations: true },
        invoke: vi.fn().mockRejectedValue(new Error("offline")),
        ai: { setRecommendations, openConversation },
      },
    });
    renderHook(() => useDBXRecommendations(dbxAIPage("/pods/ns/demo")));
    await waitFor(() =>
      expect(setRecommendations).toHaveBeenLastCalledWith(
        expect.objectContaining({
          context: expect.objectContaining({
            resource: { kind: "pod", namespace: "ns", name: "demo" },
          }),
          items: expect.arrayContaining([
            expect.objectContaining({ id: "podDetail-rootCause" }),
          ]),
        }),
      ),
    );
    expect(openConversation).not.toHaveBeenCalled();
  });

  it("does not call the new API in older hosts", async () => {
    const invoke = vi.fn();
    const setRecommendations = vi.fn();
    Object.defineProperty(window, "dbxPlugin", {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        context: { connectionId: "cluster-a" },
        capabilities: { ai: true },
        invoke,
        ai: { openConversation: vi.fn(), setRecommendations },
      },
    });
    renderHook(() => useDBXRecommendations(dbxAIPage("/pods")));
    await waitFor(() => expect(invoke).not.toHaveBeenCalled());
    expect(setRecommendations).not.toHaveBeenCalled();
  });

  it("opens an agent conversation with the current snapshot", async () => {
    const openConversation = vi.fn().mockResolvedValue(undefined);
    const invoke = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      data: { overview: { pods: 2 } },
    });
    Object.defineProperty(window, "dbxPlugin", {
      configurable: true,
      value: {
        ready: Promise.resolve(),
        context: { connectionId: "cluster-a" },
        capabilities: { ai: true },
        invoke,
        ai: { openConversation },
      },
    });
    await openDBXAIConversation(
      dbxAIPage("/pods/default/demo"),
      "Ask DBX AI",
      "Diagnose this pod",
    );
    expect(invoke).toHaveBeenCalledWith("ai/snapshot", {
      connectionId: "cluster-a",
      page: dbxAIPage("/pods/default/demo"),
    });
    expect(openConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Ask DBX AI",
        prompt: "Diagnose this pod",
        send: true,
        mode: "agent",
        context: expect.objectContaining({
          data: { overview: { pods: 2 } },
          connectionId: "cluster-a",
        }),
      }),
    );
  });
});
