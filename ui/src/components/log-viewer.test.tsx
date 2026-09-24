import userEvent from "@testing-library/user-event";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { LogViewer } from "./log-viewer";

const state = vi.hoisted(() => ({
  text: "",
  options: {} as { onNewLog?: (text: string) => void; onClear?: () => void },
  save: vi.fn(),
  zones: vi.fn(),
  decorations: vi.fn(() => []),
  action: undefined as undefined | { run: () => void },
}));
vi.mock("react-i18next", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-i18next")>()),
  useTranslation: () => ({
    t: (key: string, args?: Record<string, unknown>) =>
      args?.matched !== undefined ? `${args.matched}/${args.total}` : key,
  }),
}));
vi.mock("./appearance-provider", () => ({
  useAppearance: () => ({ actualTheme: "light" }),
}));
vi.mock("@/lib/api", () => ({
  useLogsWebSocket: (
    _ns: string,
    _pod: string,
    options: typeof state.options,
  ) => {
    state.options = options;
    return {
      isLoading: false,
      isConnected: true,
      downloadSpeed: 0,
      refetch: vi.fn(),
      stopStreaming: vi.fn(),
      clearLogs: () => options.onClear?.(),
    };
  },
}));
vi.mock("@/lib/desktop", () => ({
  saveTextFile: (...args: unknown[]) => state.save(...args),
}));
vi.mock("@/lib/desktop-preferences", () => ({
  loadViewerPreference: async () => ({
    logViewer: {
      theme: "classic",
      tailLines: 100,
      wordWrap: true,
      showLineNumbers: false,
      fontSize: 14,
    },
  }),
  updateViewerPreference: async () => {},
}));
vi.mock("./connection-indicator", () => ({ ConnectionIndicator: () => null }));
vi.mock("./network-speed-indicator", () => ({
  NetworkSpeedIndicator: () => null,
}));
vi.mock("./selector/pod-selector", () => ({ PodSelector: () => null }));
vi.mock("./selector/container-selector", () => ({
  ContainerSelector: () => null,
}));
vi.mock("@/lib/monaco-loader", async () => {
  const React = await import("react");
  return {
    MonacoEditor: ({
      onMount,
      theme,
    }: {
      onMount: (editor: unknown, monaco: unknown) => void;
      theme: string;
    }) => {
      React.useEffect(() => {
        const model = {
          getValue: () => state.text,
          setValue: (text: string) => {
            state.text = text;
          },
          getLineCount: () => state.text.split("\n").length,
          getLineMaxColumn: () =>
            (state.text.split("\n").at(-1)?.length || 0) + 1,
          applyEdits: (edits: { text: string }[]) => {
            state.text += edits[0].text;
          },
          deltaDecorations: state.decorations,
        };
        onMount(
          {
            getModel: () => model,
            getDomNode: () => null,
            updateOptions: vi.fn(),
            saveViewState: () => null,
            restoreViewState: vi.fn(),
            getVisibleRanges: () => [{ endLineNumber: 999 }],
            revealLine: vi.fn(),
            revealLineInCenter: vi.fn(),
            addAction: (action: typeof state.action) => {
              state.action = action;
            },
            getPosition: () => ({ lineNumber: 1 }),
            changeViewZones: (callback: (accessor: unknown) => void) =>
              callback({ addZone: state.zones, removeZone: vi.fn() }),
          },
          { KeyCode: { Enter: 3 } },
        );
      }, [onMount]);
      return <div data-testid="editor" data-theme={theme} />;
    },
  };
});

beforeEach(() => {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
  HTMLElement.prototype.scrollIntoView = () => {};

  state.text = "";
  state.save.mockClear();
  state.zones.mockClear();
  state.decorations.mockClear();
  localStorage.clear();
});

it("highlights text by default, toggles filtering, preserves gaps, and exports original logs", async () => {
  render(<LogViewer namespace="default" podName="pod" />);
  await screen.findByTestId("editor");
  act(() => state.options.onNewLog?.("error 500\ninfo 200\nerror 503\n"));
  await waitFor(() => expect(state.text).toContain("info 200"));
  fireEvent.change(screen.getByLabelText("logViewer.filterLogs"), {
    target: { value: "error" },
  });
  expect(state.text).toBe("error 500\ninfo 200\nerror 503");
  expect(screen.getByText("2/3")).toBeInTheDocument();
  expect(state.decorations).toHaveBeenLastCalledWith(
    expect.any(Array),
    expect.arrayContaining([
      expect.objectContaining({
        range: {
          startLineNumber: 1,
          endLineNumber: 1,
          startColumn: 1,
          endColumn: 6,
        },
        options: { inlineClassName: "log-search-match" },
      }),
    ]),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "logViewer.filterMatchingLogs" }),
  );
  expect(state.text).toBe("error 500\nerror 503");
  fireEvent.click(
    screen.getByRole("button", { name: "logViewer.showAllLogs" }),
  );
  expect(state.text).toContain("info 200");
  fireEvent.click(
    screen.getByRole("button", { name: "logViewer.filterMatchingLogs" }),
  );

  fireEvent.click(
    screen.getByRole("button", { name: "logViewer.downloadLogs" }),
  );
  await waitFor(() =>
    expect(state.save).toHaveBeenCalledWith(
      expect.objectContaining({ content: "error 500\ninfo 200\nerror 503\n" }),
    ),
  );
  act(() => state.action?.run());
  expect(state.text).toBe("error 500\nerror 503\n");
  act(() => state.options.onNewLog?.("error after separator\n"));
  await waitFor(() =>
    expect(state.text).toBe("error 500\nerror 503\n\nerror after separator"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "logViewer.clearLogsAria" }),
  );
  expect(state.text).toBe("");
  expect(screen.getByText("0/0")).toBeInTheDocument();
  act(() => state.options.onNewLog?.("error new\n"));
  await waitFor(() => expect(state.text).toBe("error new"));
});

it("keeps the selected palette independent of DBX appearance", async () => {
  const host = { theme: { appearance: "dark" } };
  Object.defineProperty(window, "dbxPlugin", {
    value: host,
    configurable: true,
  });
  const view = render(<LogViewer namespace="default" podName="pod" />);
  await waitFor(() =>
    expect(screen.getByTestId("editor")).toHaveAttribute(
      "data-theme",
      "log-theme-classic",
    ),
  );
  view.unmount();
  Reflect.deleteProperty(window, "dbxPlugin");
});

it("opens all themes in one click and previews without persisting until selected", async () => {
  render(<LogViewer namespace="default" podName="pod" />);
  await waitFor(() =>
    expect(screen.getByTestId("editor")).toHaveAttribute(
      "data-theme",
      "log-theme-classic",
    ),
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "logViewer.logTheme" }));
  expect(screen.getAllByRole("menuitemcheckbox")).toHaveLength(6);
  expect(
    screen.getByRole("menuitemcheckbox", { name: "Classic Terminal" }),
  ).toHaveAttribute("aria-checked", "true");
  const cyberpunk = screen.getByRole("menuitemcheckbox", { name: "Cyberpunk" });
  fireEvent.pointerEnter(cyberpunk);
  expect(screen.getByTestId("editor")).toHaveAttribute(
    "data-theme",
    "log-theme-cyberpunk",
  );
  expect(localStorage.getItem("log-viewer-theme")).toBe("classic");
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByTestId("editor")).toHaveAttribute(
    "data-theme",
    "log-theme-classic",
  );
  await user.click(screen.getByRole("button", { name: "logViewer.logTheme" }));
  await user.click(screen.getByRole("menuitemcheckbox", { name: "Matrix" }));
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(localStorage.getItem("log-viewer-theme")).toBe("matrix");
  expect(screen.getByTestId("editor")).toHaveAttribute(
    "data-theme",
    "log-theme-matrix",
  );
});

it("pauses and resumes automatic log scrolling from one toolbar button", async () => {
  render(<LogViewer namespace="default" podName="pod" />);
  await screen.findByTestId("editor");
  const user = userEvent.setup();
  const toggle = screen.getByRole("button", {
    name: "logViewer.pauseScrolling",
  });

  expect(toggle).toHaveAttribute("aria-pressed", "false");
  await user.click(toggle);
  expect(
    screen.getByRole("button", { name: "logViewer.resumeScrolling" }),
  ).toHaveAttribute("aria-pressed", "true");
  await user.click(
    screen.getByRole("button", { name: "logViewer.resumeScrolling" }),
  );
  expect(
    screen.getByRole("button", { name: "logViewer.pauseScrolling" }),
  ).toHaveAttribute("aria-pressed", "false");
});

it("omits tailLines when all logs are selected", async () => {
  render(<LogViewer namespace="default" podName="pod" />);
  await screen.findByTestId("editor");
  expect(state.options).toEqual(expect.objectContaining({ tailLines: 100 }));

  const user = userEvent.setup();
  const settingsButton = screen
    .getAllByRole("button")
    .find((button) => button.querySelector(".tabler-icon-settings"));
  expect(settingsButton).toBeDefined();
  await user.click(settingsButton!);
  const tailLinesSelect = within(screen.getByRole("dialog")).getAllByRole(
    "combobox",
  )[0];
  await user.click(tailLinesSelect);
  await user.click(screen.getByRole("option", { name: "logViewer.all" }));

  expect(state.options).toEqual(
    expect.objectContaining({ tailLines: undefined }),
  );

  await user.click(tailLinesSelect);
  await user.click(screen.getByRole("option", { name: "100" }));
  expect(state.options).toEqual(expect.objectContaining({ tailLines: 100 }));
});

it("highlights every literal occurrence and new logs, then resets filtering when cleared", async () => {
  render(<LogViewer namespace="default" podName="pod" />);
  await screen.findByTestId("editor");
  act(() => state.options.onNewLog?.("[WARN] [warn]\ninfo\n"));
  await waitFor(() => expect(state.text).toContain("info"));
  const input = screen.getByLabelText("logViewer.filterLogs");
  fireEvent.change(input, { target: { value: "[warn]" } });
  expect(state.text).toBe("[WARN] [warn]\ninfo");
  expect(state.decorations).toHaveBeenLastCalledWith(expect.any(Array), [
    expect.objectContaining({
      range: {
        startLineNumber: 1,
        endLineNumber: 1,
        startColumn: 1,
        endColumn: 7,
      },
    }),
    expect.objectContaining({
      range: {
        startLineNumber: 1,
        endLineNumber: 1,
        startColumn: 8,
        endColumn: 14,
      },
    }),
  ]);
  act(() => state.options.onNewLog?.("[warn] next\n"));
  await waitFor(() => expect(state.text).toContain("[warn] next"));
  expect(state.decorations).toHaveBeenLastCalledWith(
    expect.any(Array),
    expect.arrayContaining([
      expect.objectContaining({
        range: {
          startLineNumber: 3,
          endLineNumber: 3,
          startColumn: 1,
          endColumn: 7,
        },
      }),
    ]),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "logViewer.filterMatchingLogs" }),
  );
  expect(state.text).not.toContain("info");
  fireEvent.change(input, { target: { value: "" } });
  expect(state.text).toContain("info");
  expect(
    screen.queryByRole("button", { name: "logViewer.showAllLogs" }),
  ).not.toBeInTheDocument();
  expect(state.decorations).toHaveBeenLastCalledWith(expect.any(Array), []);
});
