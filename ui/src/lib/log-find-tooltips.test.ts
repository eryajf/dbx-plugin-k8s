import { expect, it, vi } from "vitest";
import { installNativeFindTooltips } from "./log-find-tooltips";

it("replaces mouse hover without blocking clicks, focus, or other editors", async () => {
  const root = document.createElement("div");
  root.innerHTML =
    '<div class="find-widget"><div custom-hover="true" aria-label="Find in Selection (⌘⇧F)"><span></span></div></div><div custom-hover="true" aria-label="Other"></div>';
  const button = root.querySelector<HTMLElement>("[custom-hover]")!;
  document.body.appendChild(root);
  const managedHover = vi.fn();
  const click = vi.fn();
  const focus = vi.fn();
  button.addEventListener("mouseover", managedHover, true);
  button.addEventListener("click", click);
  button.addEventListener("focus", focus);
  const dispose = installNativeFindTooltips(root);
  for (let i = 0; i < 10; i++) {
    button.setAttribute("aria-disabled", "true");
    button.firstElementChild!.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true }),
    );
  }
  expect(managedHover).not.toHaveBeenCalled();
  expect(button.title).toBe("Find in Selection (⌘⇧F)");
  button.click();
  button.dispatchEvent(new FocusEvent("focus"));
  expect(click).toHaveBeenCalledOnce();
  expect(focus).toHaveBeenCalledOnce();
  const other = root.lastElementChild!;
  const otherHover = vi.fn();
  other.addEventListener("mouseover", otherHover);
  other.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  expect(otherHover).toHaveBeenCalledOnce();
  button.setAttribute("custom-hover", "true");
  await Promise.resolve();
  expect(button.hasAttribute("custom-hover")).toBe(false);
  dispose();
  root.remove();
  expect(button.hasAttribute("title")).toBe(false);
  button.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
  expect(managedHover).toHaveBeenCalledOnce();
});
