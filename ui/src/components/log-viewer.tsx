import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { installNativeFindTooltips } from "@/lib/log-find-tooltips";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { OnMount } from "@monaco-editor/react";
import {
  IconDownload,
  IconFilter,
  IconMaximize,
  IconMinimize,
  IconPalette,
  IconEraser,
  IconSearch,
  IconSettings,
  IconX,
} from "@tabler/icons-react";
import { Container, Pod } from "kubernetes-types/core/v1";
import type { editor } from "monaco-editor";
import { useTranslation } from "react-i18next";

import { TERMINAL_THEMES, TerminalTheme } from "@/types/themes";
import { generateAnsiCss, getAnsiClassNames } from "@/lib/ansi-parser";
import { useLogsWebSocket } from "@/lib/api";
import { saveTextFile } from "@/lib/desktop";
import {
  loadViewerPreference,
  updateViewerPreference,
} from "@/lib/desktop-preferences";
import { toSimpleContainer } from "@/lib/k8s";
import { MonacoEditor } from "@/lib/monaco-loader";
import { defineMonacoLogThemes } from "@/lib/monaco-theme";
import { normalizeLogTheme, type LogViewerTheme } from "@/lib/log-theme";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { compileLogFilter, LogBuffer } from "@/lib/log-filter";

import { ConnectionIndicator } from "./connection-indicator";
import { NetworkSpeedIndicator } from "./network-speed-indicator";
import { ContainerSelector } from "./selector/container-selector";
import { PodSelector } from "./selector/pod-selector";

interface LogViewerProps {
  namespace: string;
  podName?: string;
  pods?: Pod[];
  labelSelector?: string;
  containers?: Container[];
  initContainers?: Container[];
  onClose?: () => void;
}

const ANSI_CSS =
  generateAnsiCss() +
  `
.log-search-match { background: #facc1566; outline: 1px solid #eab308; border-radius: 2px; }
.log-viewer-light .ansi-fg-30 { color: #202020 !important; }
.log-viewer-light .ansi-fg-32, .log-viewer-light .ansi-fg-92 { color: #16713c !important; }
.log-viewer-light .ansi-fg-33, .log-viewer-light .ansi-fg-93 { color: #806000 !important; }
.log-viewer-light .ansi-fg-36, .log-viewer-light .ansi-fg-96 { color: #007080 !important; }
.log-viewer-light .ansi-fg-37, .log-viewer-light .ansi-fg-97 { color: #404040 !important; }
.log-viewer-dark .ansi-fg-30 { color: #999999 !important; }
`;

const LOG_VIEWER_THEME_OPTIONS: Array<[LogViewerTheme, string, TerminalTheme]> =
  [
    ["classic", "Classic Terminal", "classic"],
    ["matrix", "Matrix", "matrix"],
    ["cyberpunk", "Cyberpunk", "cyberpunk"],
    ["solarized", "Solarized Dark", "solarized"],
    ["monokai", "Monokai", "monokai"],
    ["github", "GitHub Light", "github"],
  ];

export function LogViewer({
  namespace,
  podName,
  pods,
  containers: _containers,
  initContainers,
  onClose,
  labelSelector,
}: LogViewerProps) {
  const [logTheme, setLogTheme] = useState<LogViewerTheme>(() => {
    return normalizeLogTheme(localStorage.getItem("log-viewer-theme"));
  });
  const [previewLogTheme, setPreviewLogTheme] = useState<LogViewerTheme | null>(
    null,
  );
  const containers = useMemo(() => {
    return toSimpleContainer(initContainers, _containers);
  }, [_containers, initContainers]);
  const [selectedContainer, setSelectedContainer] = useState<
    string | undefined
  >(containers.length > 0 ? containers[0].name : "");
  const [tailLines, setTailLines] = useState(() => {
    const saved = localStorage.getItem("log-viewer-tail-lines");
    return saved ? parseInt(saved, 10) : 100;
  });
  const { t } = useTranslation();
  const [timestamps, setTimestamps] = useState(false);
  const [previous, setPrevious] = useState(false);
  const [filterTerm, setFilterTerm] = useState("");
  const [filterEnabled, setFilterEnabled] = useState(false);
  const searchRef = useRef({ query: "", filtering: false });
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [wordWrap, setWordWrap] = useState<boolean>(() => {
    const saved = localStorage.getItem("log-viewer-word-wrap");
    if (saved === null) {
      localStorage.setItem("log-viewer-word-wrap", "true");
      return true;
    }
    return saved === "true";
  });

  const [showLineNumbers, setShowLineNumbers] = useState<boolean>(() => {
    const saved = localStorage.getItem("log-viewer-show-line-numbers");
    if (saved === null) {
      return false;
    }
    return saved === "true";
  });

  const [fontSize, setFontSize] = useState(() => {
    const saved = localStorage.getItem("log-viewer-font-size");
    return saved ? parseInt(saved, 10) : 14;
  });
  // Separators are model lines so that subsequent streamed logs are appended
  // after the gap instead of replacing a view-only spacer.
  const separatorOffsetsRef = useRef<number[]>([]);
  const findTooltipCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => findTooltipCleanupRef.current?.(), []);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [logCount, setLogCount] = useState(0);
  const [totalLogCount, setTotalLogCount] = useState(0);
  const decorationIdsRef = useRef<string[]>([]);
  const logBufferRef = useRef(new LogBuffer());
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeFilterRef = useRef(compileLogFilter(""));
  const sortedPods = useMemo(() => {
    if (!pods) {
      return undefined;
    }

    return [...pods].sort((a, b) =>
      (a.metadata?.creationTimestamp || 0) >
      (b.metadata?.creationTimestamp || 0)
        ? -1
        : 1,
    );
  }, [pods]);
  const effectiveLogTheme: TerminalTheme = logTheme;
  const visibleLogTheme = previewLogTheme ?? effectiveLogTheme;
  const viewerPreferenceReadyRef = useRef(false);
  const lastPersistedViewerPreferenceRef = useRef<string | null>(null);

  const [selectPodName, setSelectPodName] = useState<string | undefined>(
    podName || pods?.[0]?.metadata?.name || undefined,
  );

  useEffect(() => {
    let cancelled = false;

    const loadPreference = async () => {
      try {
        const preference = await loadViewerPreference();
        if (cancelled) {
          return;
        }

        const savedTheme = preference.logViewer.theme;
        setLogTheme(normalizeLogTheme(savedTheme));
        setTailLines(preference.logViewer.tailLines);
        setWordWrap(preference.logViewer.wordWrap);
        setShowLineNumbers(preference.logViewer.showLineNumbers);
        setFontSize(preference.logViewer.fontSize);
        localStorage.setItem("log-viewer-theme", preference.logViewer.theme);
        localStorage.setItem(
          "log-viewer-tail-lines",
          preference.logViewer.tailLines.toString(),
        );
        localStorage.setItem(
          "log-viewer-word-wrap",
          String(preference.logViewer.wordWrap),
        );
        localStorage.setItem(
          "log-viewer-show-line-numbers",
          String(preference.logViewer.showLineNumbers),
        );
        localStorage.setItem(
          "log-viewer-font-size",
          preference.logViewer.fontSize.toString(),
        );
        lastPersistedViewerPreferenceRef.current = JSON.stringify(
          preference.logViewer,
        );
      } catch (error) {
        console.error("Failed to load viewer preference from storage:", error);
      } finally {
        if (!cancelled) {
          viewerPreferenceReadyRef.current = true;
        }
      }
    };

    void loadPreference();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (podName) {
      if (selectPodName !== podName) {
        setSelectPodName(podName);
      }
      return;
    }
    if (pods && pods.length > 0) {
      if (
        selectPodName !== "_all" &&
        (!selectPodName ||
          !pods.find((p) => p.metadata?.name === selectPodName))
      ) {
        setSelectPodName(pods[0].metadata?.name);
      }
    }
  }, [podName, pods, selectPodName]);

  useEffect(() => {
    if (containers.length > 0) {
      setSelectedContainer(containers[0].name);
    }
  }, [containers]);

  // Handle theme change and persist to localStorage
  const handleThemeChange = useCallback((theme: LogViewerTheme) => {
    setLogTheme(theme);
    setPreviewLogTheme(null);
    localStorage.setItem("log-viewer-theme", theme);
  }, []);

  const handleThemePreview = useCallback((theme: LogViewerTheme) => {
    setPreviewLogTheme(theme);
  }, []);

  const restoreThemePreview = useCallback(() => {
    setPreviewLogTheme(null);
  }, []);

  // Handle font size change and persist to localStorage
  const handleFontSizeChange = useCallback((size: number) => {
    setFontSize(size);
    localStorage.setItem("log-viewer-font-size", size.toString());
  }, []);

  // Handle tail lines change and persist to localStorage
  const handleTailLinesChange = useCallback((lines: number) => {
    setTailLines(lines);
    if (lines !== -1) {
      localStorage.setItem("log-viewer-tail-lines", lines.toString());
    }
  }, []);

  useEffect(() => {
    if (!viewerPreferenceReadyRef.current) {
      return;
    }

    const serialized = JSON.stringify({
      theme: logTheme,
      tailLines,
      wordWrap,
      showLineNumbers,
      fontSize,
    });
    if (serialized === lastPersistedViewerPreferenceRef.current) {
      return;
    }

    lastPersistedViewerPreferenceRef.current = serialized;
    void updateViewerPreference((preference) => ({
      ...preference,
      logViewer: {
        theme: logTheme,
        tailLines,
        wordWrap,
        showLineNumbers,
        fontSize,
      },
    })).catch((error) => {
      console.error("Failed to save viewer preference to storage:", error);
    });
  }, [fontSize, logTheme, showLineNumbers, tailLines, wordWrap]);

  const renderLogEntries = useCallback(() => {
    if (!editorRef.current) {
      return;
    }
    const model = editorRef.current.getModel();
    if (!model) return;
    const entries = logBufferRef.current.lines;
    const visibleEntries = entries.filter(
      (entry) =>
        !searchRef.current.filtering ||
        activeFilterRef.current.test(entry.plainText),
    );
    const separatorOffsets = separatorOffsetsRef.current
      .map(
        (offset) =>
          entries
            .slice(0, offset)
            .filter(
              (entry) =>
                !searchRef.current.filtering ||
                activeFilterRef.current.test(entry.plainText),
            ).length,
      )
      .sort((a, b) => a - b);
    const renderedLines: string[] = [];
    separatorOffsets.forEach((offset) => {
      if (offset === 0) renderedLines.push("");
    });
    visibleEntries.forEach((entry, index) => {
      renderedLines.push(entry.plainText);
      separatorOffsets.forEach((offset) => {
        if (offset === index + 1) renderedLines.push("");
      });
    });
    const text = renderedLines.join("\n");
    const oldText = model.getValue();
    const view = editorRef.current.saveViewState();
    const visibleRange = editorRef.current.getVisibleRanges()[0];
    const wasAtBottom =
      !oldText ||
      (visibleRange?.endLineNumber ?? 0) + 2 >= model.getLineCount();
    if (text !== oldText) {
      if (text.startsWith(oldText)) {
        const line = model.getLineCount();
        const column = model.getLineMaxColumn(line);
        model.applyEdits([
          {
            range: {
              startLineNumber: line,
              endLineNumber: line,
              startColumn: column,
              endColumn: column,
            },
            text: text.slice(oldText.length),
          },
        ]);
      } else {
        model.setValue(text);
      }
    }
    const newDecorations: editor.IModelDeltaDecoration[] = [];
    let currentLine = 1;
    let currentColumn = 1;
    visibleEntries.forEach((entry, index) => {
      currentLine =
        index + 1 + separatorOffsets.filter((offset) => offset <= index).length;
      currentColumn = 1;
      const query = searchRef.current.query;
      if (query) {
        const source = entry.plainText.toLocaleLowerCase();
        const needle = query.toLocaleLowerCase();
        for (
          let start = source.indexOf(needle);
          start !== -1;
          start = source.indexOf(needle, start + needle.length)
        ) {
          newDecorations.push({
            range: {
              startLineNumber: currentLine,
              endLineNumber: currentLine,
              startColumn: start + 1,
              endColumn: start + query.length + 1,
            },
            options: { inlineClassName: "log-search-match" },
          });
        }
      }
      entry.segments.forEach((segment) => {
        const lines = segment.text.split("\n");
        const endLine = currentLine + lines.length - 1;
        const endColumn =
          lines.length === 1
            ? currentColumn + lines[0].length
            : lines[lines.length - 1].length + 1;

        const className = getAnsiClassNames(segment.styles);
        if (className) {
          newDecorations.push({
            range: {
              startLineNumber: currentLine,
              startColumn: currentColumn,
              endLineNumber: endLine,
              endColumn: endColumn,
            },
            options: {
              inlineClassName: className,
            },
          });
        }

        currentLine = endLine;
        currentColumn = endColumn;
      });
    });
    decorationIdsRef.current = model.deltaDecorations(
      decorationIdsRef.current,
      newDecorations,
    );
    if (wasAtBottom) {
      editorRef.current.revealLine(model.getLineCount());
      setShowScrollToBottom(false);
    } else {
      if (view) editorRef.current.restoreViewState(view);
      setShowScrollToBottom(true);
    }
    setLogCount(
      entries.filter((entry) => activeFilterRef.current.test(entry.plainText))
        .length,
    );
    setTotalLogCount(entries.length);
  }, []);

  const writeLogToEditor = useCallback(
    (log: string) => {
      logBufferRef.current.append(log);
      if (renderTimerRef.current === null) {
        renderTimerRef.current = setTimeout(() => {
          renderTimerRef.current = null;
          renderLogEntries();
        }, 100);
      }
    },
    [renderLogEntries],
  );

  useEffect(
    () => () => {
      if (renderTimerRef.current !== null) clearTimeout(renderTimerRef.current);
    },
    [],
  );

  // Handle editor mount
  const handleEditorMount: OnMount = useCallback(
    (editor, monaco) => {
      editorRef.current = editor;
      findTooltipCleanupRef.current?.();
      const editorNode = editor.getDomNode();
      findTooltipCleanupRef.current = editorNode
        ? installNativeFindTooltips(editorNode)
        : null;

      // Configure search widget
      editor.updateOptions({
        find: {
          addExtraSpaceOnTop: false,
          autoFindInSelection: "never",
          seedSearchStringFromSelection: "never",
        },
      });

      editor.addAction({
        id: "log-viewer.add-separator",
        label: "Insert visual separator",
        keybindings: [monaco.KeyCode.Enter],
        precondition: "editorTextFocus && !findWidgetVisible",
        run: () => {
          separatorOffsetsRef.current.push(logBufferRef.current.lines.length);
          renderLogEntries();
          requestAnimationFrame(() =>
            editor.revealLineInCenter(editor.getModel()?.getLineCount() || 1),
          );
        },
      });
      renderLogEntries();
    },
    [renderLogEntries],
  );

  const appendLog = useCallback(
    (log: string) => {
      writeLogToEditor(log);
    },
    [writeLogToEditor],
  );

  const cleanLog = useCallback(() => {
    setLogCount(0);
    setTotalLogCount(0);
    separatorOffsetsRef.current = [];
    decorationIdsRef.current = [];
    logBufferRef.current.clear();
    if (renderTimerRef.current !== null) clearTimeout(renderTimerRef.current);
    renderTimerRef.current = null;
    if (editorRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        model.setValue("");
      }
    }
  }, []);

  useEffect(() => {
    searchRef.current = { query: filterTerm, filtering: filterEnabled };
    activeFilterRef.current = compileLogFilter(filterTerm);
    renderLogEntries();
  }, [filterTerm, filterEnabled, renderLogEntries]);

  const logsOptions = useMemo(
    () => ({
      container: selectedContainer,
      tailLines,
      timestamps,
      previous,
      enabled: !!selectPodName,
      labelSelector,
      onNewLog: appendLog,
      onClear: cleanLog,
    }),
    [
      selectedContainer,
      tailLines,
      timestamps,
      previous,
      selectPodName,
      labelSelector,
      appendLog,
      cleanLog,
    ],
  );

  // Use the new WebSocket logs hook
  const {
    isLoading,
    isConnected,
    downloadSpeed,
    refetch,
    stopStreaming,
    clearLogs,
  } = useLogsWebSocket(namespace, selectPodName || "", logsOptions);

  const stopStreamingRef = useRef<() => void>(stopStreaming);
  stopStreamingRef.current = stopStreaming;

  // Clean up WebSocket connection when component unmounts
  useEffect(() => {
    return () => {
      if (stopStreamingRef.current) {
        stopStreamingRef.current();
      }
    };
  }, []);

  // Stop previous stream when critical parameters change
  useEffect(() => {
    // Show reconnecting state when parameters change
    setIsReconnecting(true);

    // Reset reconnecting state when loading stops
    const timer = setTimeout(() => {
      if (!isLoading) {
        setIsReconnecting(false);
      }
    }, 500);

    return () => clearTimeout(timer);
  }, [
    selectedContainer,
    selectPodName,
    tailLines,
    timestamps,
    previous,
    isLoading,
  ]);

  // Hide reconnecting state when loading completes
  useEffect(() => {
    if (!isLoading) {
      const timer = setTimeout(() => setIsReconnecting(false), 200);
      return () => clearTimeout(timer);
    }
  }, [isLoading]);

  const downloadLogs = async () => {
    const model = editorRef?.current?.getModel();
    if (model) {
      const content = logBufferRef.current.text;
      const podFileName = selectPodName || "all-pods";
      const fileName = `${podFileName}-${selectedContainer || "pod"}-logs.txt`;
      try {
        const result = await saveTextFile({
          title: "Save Logs",
          message: "Choose where to save the exported logs",
          buttonText: "Save",
          suggestedName: fileName,
          content,
          filters: [
            {
              displayName: "Text Files",
              pattern: "*.txt",
            },
          ],
        });
        if (result.canceled) {
          toast.info(t("logViewer.downloadCanceled"));
        } else {
          toast.success(t("logViewer.downloadSuccess"));
        }
      } catch {
        toast.error(t("logViewer.downloadFailed"));
      }
    }
  };

  const scrollToBottom = useCallback(() => {
    if (editorRef.current) {
      const model = editorRef.current.getModel();
      if (model) {
        editorRef.current.revealLine(model.getLineCount());
        setShowScrollToBottom(false);
      }
    }
  }, []);

  // Handle fullscreen toggle
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  const toggleWordWrap = useCallback(() => {
    setWordWrap((prev) => {
      localStorage.setItem("log-viewer-word-wrap", `${!prev}`);
      return !prev;
    });
  }, []);

  const toggleShowLineNumbers = useCallback(() => {
    setShowLineNumbers((prev) => {
      localStorage.setItem("log-viewer-show-line-numbers", `${!prev}`);
      return !prev;
    });
  }, []);

  // Handle keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + F to open Monaco search
      if ((e.ctrlKey || e.metaKey) && e.key === "f") {
        e.preventDefault();
        editorRef.current?.getAction("actions.find")?.run();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        toggleFullscreen();
      }
      // Alt/Option + Z to toggle word wrap
      if (e.altKey && (e.key === "z" || e.key === "Z" || e.key === "Ω")) {
        e.preventDefault();
        toggleWordWrap();
      }
      // Font size shortcuts
      if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        handleFontSizeChange(Math.min(24, fontSize + 1));
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === "-" || e.key === "_")) {
        e.preventDefault();
        handleFontSizeChange(Math.max(10, fontSize - 1));
      }
      if ((e.ctrlKey || e.metaKey) && e.key === "0") {
        e.preventDefault();
        handleFontSizeChange(14); // Reset to default font size
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [toggleFullscreen, fontSize, handleFontSizeChange, toggleWordWrap]);

  return (
    <Card
      className={`log-viewer-${effectiveLogTheme === "github" ? "light" : "dark"} h-full flex flex-col py-4 gap-0 ${isFullscreen ? "fixed inset-0 z-50 m-0 rounded-none" : ""} ${wordWrap ? "whitespace-pre-wrap" : "whitespace-pre"} `}
    >
      <style>{ANSI_CSS}</style>
      <CardHeader>
        <div className="flex min-w-0 flex-nowrap items-center justify-between gap-2">
          <div className="flex min-w-0 shrink items-center gap-2">
            <CardTitle className="text-lg">{t("logViewer.title")}</CardTitle>
            <CardDescription>
              <div className="flex items-center gap-4 text-sm text-muted-foreground">
                <span>
                  {filterTerm.length > 0
                    ? t("logViewer.matchCount", {
                        matched: logCount,
                        total: totalLogCount,
                      })
                    : t("logViewer.lines", { count: totalLogCount })}
                </span>
                <ConnectionIndicator
                  isConnected={isConnected}
                  onReconnect={refetch}
                />
                <NetworkSpeedIndicator
                  downloadSpeed={downloadSpeed}
                  uploadSpeed={0}
                />
                {isLoading && <span>{t("logViewer.loading")}</span>}
                {isReconnecting && (
                  <span className="text-blue-600">
                    {t("logViewer.reconnecting")}
                  </span>
                )}
              </div>
            </CardDescription>
          </div>
          <div className="flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-2 overflow-x-auto">
            <div className="relative w-64 min-w-0 shrink-0">
              <IconSearch className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t("logViewer.filterLogs")}
                value={filterTerm}
                onChange={(e) => {
                  setFilterTerm(e.target.value);
                  if (!e.target.value) setFilterEnabled(false);
                }}
                className="w-full min-w-0 pl-8 pr-10"
                aria-label={t("logViewer.filterLogs")}
              />
              {filterTerm && (
                <Button
                  variant={filterEnabled ? "secondary" : "ghost"}
                  size="icon"
                  className="absolute right-1 top-1 h-7 w-7"
                  aria-pressed={filterEnabled}
                  aria-label={t(
                    filterEnabled
                      ? "logViewer.showAllLogs"
                      : "logViewer.filterMatchingLogs",
                  )}
                  title={t(
                    filterEnabled
                      ? "logViewer.showAllLogs"
                      : "logViewer.filterMatchingLogs",
                  )}
                  onClick={() => setFilterEnabled((enabled) => !enabled)}
                >
                  <IconFilter className="h-4 w-4" />
                </Button>
              )}
            </div>

            {/* Container Selector */}
            {containers.length > 1 && (
              <ContainerSelector
                containers={containers}
                showAllOption={false}
                selectedContainer={selectedContainer}
                onContainerChange={setSelectedContainer}
              />
            )}

            {/* Pod Selector */}
            {sortedPods && (
              <PodSelector
                pods={sortedPods}
                showAllOption={true}
                selectedPod={selectPodName}
                onPodChange={(v) => setSelectPodName(v || "_all")}
              />
            )}

            {/* Theme choices open directly from the palette button. */}
            <DropdownMenu
              onOpenChange={(open) => {
                if (!open) restoreThemePreview();
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={t("logViewer.logTheme")}
                  title={t("logViewer.currentTheme", {
                    name: TERMINAL_THEMES[logTheme].name,
                  })}
                  className="relative"
                >
                  <IconPalette className="h-4 w-4" />
                  <span
                    className="absolute -top-1 -right-1 h-3 w-3 rounded-full border border-gray-400"
                    style={{
                      backgroundColor: TERMINAL_THEMES[logTheme].background,
                    }}
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-60"
                onPointerLeave={restoreThemePreview}
              >
                {LOG_VIEWER_THEME_OPTIONS.map(([key, label, themeKey]) => (
                  <DropdownMenuCheckboxItem
                    key={key}
                    checked={logTheme === key}
                    onSelect={() => handleThemeChange(key)}
                    onPointerEnter={() => handleThemePreview(key)}
                    onFocus={() => handleThemePreview(key)}
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-full border border-gray-400"
                      style={{
                        backgroundColor: TERMINAL_THEMES[themeKey].background,
                      }}
                    />
                    {label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {/* Settings */}
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" size="sm">
                  <IconSettings className="h-4 w-4" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80" align="end">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="tail-lines">
                      {t("logViewer.tailLines")}
                    </Label>
                    <Select
                      value={tailLines.toString()}
                      onValueChange={(value) =>
                        handleTailLinesChange(Number(value))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="50">50</SelectItem>
                        <SelectItem value="100">100</SelectItem>
                        <SelectItem value="200">200</SelectItem>
                        <SelectItem value="500">500</SelectItem>
                        <SelectItem value="1000">1000</SelectItem>
                        <SelectItem value="-1">{t("logViewer.all")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="timestamps">
                      {t("logViewer.showTimestamps")}
                    </Label>
                    <Switch
                      id="timestamps"
                      checked={timestamps}
                      onCheckedChange={setTimestamps}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="previous">
                      {t("logViewer.previousContainer")}
                    </Label>
                    <Switch
                      id="previous"
                      checked={previous}
                      onCheckedChange={setPrevious}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="word-wrap">{t("logViewer.wordWrap")}</Label>
                    <Switch
                      id="word-wrap"
                      checked={wordWrap}
                      onCheckedChange={toggleWordWrap}
                    />
                  </div>

                  <div className="flex items-center justify-between">
                    <Label htmlFor="show-line-numbers">
                      {t("logViewer.showLineNumbers")}
                    </Label>
                    <Switch
                      id="show-line-numbers"
                      checked={showLineNumbers}
                      onCheckedChange={toggleShowLineNumbers}
                    />
                  </div>

                  {/* Log Theme Selector */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="log-theme">
                        {t("logViewer.logTheme")}
                      </Label>
                      <Select
                        value={logTheme}
                        onValueChange={(value) =>
                          handleThemeChange(value as LogViewerTheme)
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent onPointerLeave={restoreThemePreview}>
                          {LOG_VIEWER_THEME_OPTIONS.map(
                            ([key, label, themeKey]) => (
                              <SelectItem
                                key={key}
                                value={key}
                                onPointerEnter={() => handleThemePreview(key)}
                                onFocus={() => handleThemePreview(key)}
                              >
                                <div className="flex items-center gap-2">
                                  <span
                                    className="h-3 w-3 rounded-full border"
                                    style={{
                                      backgroundColor:
                                        TERMINAL_THEMES[themeKey].background,
                                    }}
                                  />
                                  {label}
                                </div>
                              </SelectItem>
                            ),
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Font Size Selector */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="font-size">
                        {t("logViewer.fontSize")}
                      </Label>
                      <Select
                        value={fontSize.toString()}
                        onValueChange={(value) =>
                          handleFontSizeChange(Number(value))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="10">10px</SelectItem>
                          <SelectItem value="11">11px</SelectItem>
                          <SelectItem value="12">12px</SelectItem>
                          <SelectItem value="13">13px</SelectItem>
                          <SelectItem value="14">14px</SelectItem>
                          <SelectItem value="15">15px</SelectItem>
                          <SelectItem value="16">16px</SelectItem>
                          <SelectItem value="18">18px</SelectItem>
                          <SelectItem value="20">20px</SelectItem>
                          <SelectItem value="22">22px</SelectItem>
                          <SelectItem value="24">24px</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  {/* Keyboard Shortcuts */}
                  <div className="space-y-2 pt-2 border-t">
                    <Label className="text-xs font-medium text-muted-foreground">
                      {t("logViewer.keyboardShortcuts")}
                    </Label>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div className="flex justify-between">
                        <span>{t("logViewer.openSearch")}</span>
                        <kbd className="px-1 py-0.5 bg-muted rounded text-xs">
                          Ctrl+F
                        </kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>{t("logViewer.toggleFullscreen")}</span>
                        <kbd className="px-1 py-0.5 bg-muted rounded text-xs">
                          Ctrl+Enter
                        </kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>{t("logViewer.wordWrap")}</span>
                        <kbd className="px-1 py-0.5 bg-muted rounded text-xs">
                          Alt+Z
                        </kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>{t("logViewer.increaseFontSize")}</span>
                        <kbd className="px-1 py-0.5 bg-muted rounded text-xs">
                          Ctrl++
                        </kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>{t("logViewer.decreaseFontSize")}</span>
                        <kbd className="px-1 py-0.5 bg-muted rounded text-xs">
                          Ctrl+-
                        </kbd>
                      </div>
                      <div className="flex justify-between">
                        <span>{t("logViewer.resetFontSize")}</span>
                        <kbd className="px-1 py-0.5 bg-muted rounded text-xs">
                          Ctrl+0
                        </kbd>
                      </div>
                    </div>
                  </div>
                </div>
              </PopoverContent>
            </Popover>

            {/* Clear Logs */}
            <Button
              variant="outline"
              size="sm"
              onClick={clearLogs}
              title={t("logViewer.clearLogs")}
              aria-label={t("logViewer.clearLogsAria")}
            >
              <IconEraser className="h-4 w-4" />
            </Button>

            {/* Download */}
            <Button
              variant="outline"
              size="sm"
              onClick={downloadLogs}
              disabled={totalLogCount === 0}
              title={t("logViewer.downloadLogs")}
              aria-label={t("logViewer.downloadLogs")}
            >
              <IconDownload className="h-4 w-4" />
            </Button>

            {/* Fullscreen Toggle */}
            <Button
              variant="outline"
              size="sm"
              onClick={toggleFullscreen}
              title={
                isFullscreen
                  ? t("logViewer.exitFullscreen")
                  : t("logViewer.enterFullscreen")
              }
            >
              {isFullscreen ? (
                <IconMinimize className="h-4 w-4" />
              ) : (
                <IconMaximize className="h-4 w-4" />
              )}
            </Button>

            {/* Close */}
            {onClose && (
              <Button variant="outline" size="sm" onClick={onClose}>
                <IconX className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 p-0 relative">
        <Suspense
          fallback={
            <div
              className="flex h-full items-center justify-center"
              style={{
                height: isFullscreen
                  ? "calc(100dvh - 60px)"
                  : "calc(100dvh - 255px)",
              }}
            >
              <div className="text-center opacity-60">
                {t("logViewer.loadingEditor")}
              </div>
            </div>
          }
        >
          <MonacoEditor
            height={
              isFullscreen ? "calc(100dvh - 60px)" : "calc(100dvh - 255px)"
            }
            theme={`log-theme-${visibleLogTheme}`}
            beforeMount={(monaco) => {
              defineMonacoLogThemes(monaco);
            }}
            onMount={handleEditorMount}
            options={{
              readOnly: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              fontSize,
              wordWrap: wordWrap ? "on" : "off",
              lineHeight: 1.7,
              insertSpaces: true,
              fontFamily:
                "'Maple Mono',Monaco, 'Cascadia Code', 'Roboto Mono', Consolas, 'Courier New', monospace",
              lineNumbers: showLineNumbers ? "on" : "off",
              glyphMargin: false,
              folding: false,
              renderLineHighlight: "gutter",
              scrollbar: {
                vertical: "visible",
                horizontal: "visible",
                useShadows: false,
                verticalScrollbarSize: 10,
                horizontalScrollbarSize: 10,
              },
              overviewRulerLanes: 0,
              hideCursorInOverviewRuler: true,
              overviewRulerBorder: false,
              automaticLayout: true,
              colorDecorators: false,
            }}
          />
        </Suspense>
        {showScrollToBottom && (
          <div
            className={`absolute bottom-4 right-4 shadow-lg z-10  ml-auto w-fit animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ${
              effectiveLogTheme === "github"
                ? "bg-white/90 text-gray-600 border border-gray-200 shadow-sm"
                : "bg-gray-800/90 text-gray-300 border border-gray-600 shadow-sm"
            } px-3 py-1.5 text-xs rounded-full backdrop-blur-sm`}
          >
            <Button
              size="sm"
              variant="ghost"
              className={`h-auto p-0 text-xs font-normal ${
                effectiveLogTheme === "github"
                  ? "text-gray-600 hover:text-gray-800 hover:bg-gray-100/70"
                  : "text-gray-300 hover:text-white hover:bg-gray-700/70"
              }`}
              onClick={scrollToBottom}
            >
              ↓ {t("log.jumpToBottom", "Jump to bottom")}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
