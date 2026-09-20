/** Keep streaming-editor toolbar tooltips independent of Monaco hover layout. */
export function installNativeFindTooltips(editorNode: HTMLElement) {
  const onMouseOver = (event: MouseEvent) => {
    if (!(event.target instanceof Element)) return;
    const target = event.target.closest<HTMLElement>("[custom-hover]");
    if (
      !target ||
      !editorNode.contains(target) ||
      !target.closest(".find-widget")
    )
      return;
    // Monaco installs its managed-hover listener directly on the control in
    // capture phase. Document capture runs first, so prevent the hover layer
    // from being recreated while streaming output updates the editor.
    event.stopImmediatePropagation();
  };
  document.addEventListener("mouseover", onMouseOver, true);
  return () => {
    document.removeEventListener("mouseover", onMouseOver, true);
  };
}
