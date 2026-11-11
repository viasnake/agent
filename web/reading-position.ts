import { useLayoutEffect, useRef } from "react";

function readerAnchor(viewport: HTMLElement) {
  const top = viewport.getBoundingClientRect().top;
  const element = [
    ...viewport.querySelectorAll<HTMLElement>("[data-entry-id]"),
  ].find((node) => node.getBoundingClientRect().bottom > top);
  return element ? { element, top: element.getBoundingClientRect().top } : null;
}

// Assistant UI owns message growth, history prepends and explicit navigation.
// This hook only preserves the reader's anchor when surrounding UI changes size.
export function useReadingPosition() {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = ref.current;
    if (!viewport) return;
    const geometry = () => {
      const { top, width, height } = viewport.getBoundingClientRect();
      return { top, width, height };
    };
    let bounds = geometry();
    let anchor: { element: HTMLElement; top: number } | null = null;
    let atBottom = true;
    const capture = () => {
      if (!viewport.clientHeight) return;
      bounds = geometry();
      atBottom =
        viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop <= 1;
      anchor = readerAnchor(viewport);
    };
    const changed = () => {
      const next = geometry();
      return (
        next.top !== bounds.top ||
        next.width !== bounds.width ||
        next.height !== bounds.height
      );
    };
    const onScroll = () => {
      // A layout-induced scroll event must not overwrite the pre-resize anchor.
      if (!changed()) capture();
    };
    const observer = new ResizeObserver(() => {
      if (!viewport.clientHeight) return;
      if (changed() && !atBottom && anchor?.element.isConnected) {
        const next = geometry();
        // Closing search reveals space above the reader. Opening it must leave
        // the anchor inside the smaller viewport, including partially read messages.
        const target = anchor.top + Math.max(0, next.top - bounds.top);
        viewport.scrollTo({
          top:
            viewport.scrollTop +
            anchor.element.getBoundingClientRect().top -
            target,
          behavior: "instant",
        });
      }
      capture();
    });
    capture();
    observer.observe(viewport);
    viewport.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      viewport.removeEventListener("scroll", onScroll);
    };
  }, []);
  return ref;
}
