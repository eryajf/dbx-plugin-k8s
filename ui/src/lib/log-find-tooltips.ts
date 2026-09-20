/** Keep streaming-editor toolbar tooltips independent of Monaco hover layout. */
type FindTooltipTranslator = (key: string) => string;

const FIND_TOOLTIP_KEYS: Record<string, string> = {
  "Match Case": "logViewer.findMatchCase",
  "Match Whole Word": "logViewer.findMatchWholeWord",
  "Use Regular Expression": "logViewer.findUseRegex",
  "Find in Selection": "logViewer.findInSelection",
  "Previous Match": "logViewer.findPrevious",
  "Next Match": "logViewer.findNext",
  Close: "logViewer.findClose",
};

export function installNativeFindTooltips(
  editorNode: HTMLElement,
  translate?: FindTooltipTranslator,
) {
  const originalTitles = new Map<HTMLElement, string>();
  let tooltip: HTMLDivElement | null = null;
  let showTimer: ReturnType<typeof setTimeout> | null = null;
  let tooltipTarget: HTMLElement | null = null;

  const hideTooltip = () => {
    if (showTimer !== null) {
      clearTimeout(showTimer);
      showTimer = null;
    }
    tooltipTarget = null;
    tooltip?.remove();
    tooltip = null;
  };

  const showTooltip = (target: HTMLElement, label: string) => {
    hideTooltip();
    tooltipTarget = target;
    showTimer = setTimeout(() => {
      showTimer = null;
      if (!tooltipTarget || !editorNode.contains(tooltipTarget)) return;
      const rect = tooltipTarget.getBoundingClientRect();
      tooltip = document.createElement("div");
      tooltip.className = "dbx-find-tooltip";
      const shortcut = label.match(/\(([^()]*)\)\s*$/)?.[1];
      const baseLabel = label.replace(/\s*\([^()]*\)\s*$/, "");
      const translationKey = FIND_TOOLTIP_KEYS[baseLabel];
      const localizedLabel =
        (translationKey && translate?.(translationKey)) || baseLabel;
      tooltip.textContent = shortcut
        ? `${localizedLabel} (${shortcut})`
        : localizedLabel;
      Object.assign(tooltip.style, {
        position: "fixed",
        top: "0px",
        left: "0px",
        zIndex: "10000",
        padding: "4px 8px",
        borderRadius: "4px",
        background: "var(--vscode-editorHoverWidget-background, #252526)",
        color: "var(--vscode-editorHoverWidget-foreground, #f1f1f1)",
        border: "1px solid var(--vscode-editorHoverWidget-border, #454545)",
        boxShadow: "0 2px 8px rgba(0, 0, 0, 0.35)",
        font: "12px sans-serif",
        whiteSpace: "nowrap",
        pointerEvents: "none",
      });
      document.body.appendChild(tooltip);
      const tooltipRect = tooltip.getBoundingClientRect();
      const margin = 8;
      const left = Math.min(
        Math.max(margin, rect.right - tooltipRect.width),
        Math.max(margin, window.innerWidth - tooltipRect.width - margin),
      );
      const below = rect.bottom + 6;
      const above = rect.top - tooltipRect.height - 6;
      const top =
        below + tooltipRect.height <= window.innerHeight - margin
          ? below
          : Math.max(margin, above);
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
    }, 400);
  };
  const disableManagedFindTooltips = () => {
    // Monaco recreates the find widget controls while the model is updated.
    // Removing this marker makes those controls invisible to the managed-hover
    // service, so a tooltip cannot be repeatedly scheduled under a stationary
    // pointer. The controls keep their aria labels and remain clickable/focusable.
    editorNode
      .querySelectorAll<HTMLElement>(".find-widget [custom-hover]")
      .forEach((target) => {
        target.removeAttribute("custom-hover");
        // Monaco puts the localized shortcut label in aria-label and clears
        // title when installing its managed hover. Restore it as a native,
        // stable tooltip after disabling the managed one.
        const label = target.getAttribute("aria-label");
        if (label && target.title !== label) {
          if (!originalTitles.has(target)) {
            originalTitles.set(target, target.title);
          }
          target.title = label;
        }
      });
  };

  disableManagedFindTooltips();
  const observer = new MutationObserver(disableManagedFindTooltips);
  observer.observe(editorNode, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["custom-hover"],
  });

  const onMouseOver = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>("[custom-hover]");
    const findWidget = event.target.closest<HTMLElement>(".find-widget");
    const tooltipControl =
      target ?? event.target.closest<HTMLElement>(".find-widget [aria-label]");
    if (
      (!target && !findWidget) ||
      !editorNode.contains(target ?? findWidget) ||
      !findWidget
    )
      return;
    // Monaco installs its managed-hover listener directly on the control in
    // capture phase. Document capture runs first, so prevent the hover layer
    // from being recreated while streaming output updates the editor.
    event.stopImmediatePropagation();
    const label = tooltipControl?.getAttribute("aria-label");
    if (
      tooltipControl &&
      label &&
      !(tooltipControl instanceof HTMLInputElement)
    ) {
      showTooltip(tooltipControl, label);
    }
  };
  const onMouseOut = (event: MouseEvent) => {
    if (!tooltipTarget || !(event.target instanceof Element)) return;
    const related = event.relatedTarget;
    if (!(related instanceof Node) || !tooltipTarget.contains(related)) {
      hideTooltip();
    }
  };
  document.addEventListener("mouseover", onMouseOver, true);
  document.addEventListener("mouseout", onMouseOut, true);
  return () => {
    observer.disconnect();
    document.removeEventListener("mouseover", onMouseOver, true);
    document.removeEventListener("mouseout", onMouseOut, true);
    hideTooltip();
    originalTitles.forEach((title, target) => {
      if (title) target.title = title;
      else target.removeAttribute("title");
    });
  };
}
