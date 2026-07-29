// Feed pinning (T106, §12.7): opening a feed lands on the NEWEST message and
// stays pinned while the operator is at the bottom. The lastId effect alone is
// not enough — async media (images, players) grow scrollHeight AFTER the
// scroll ran, leaving the view mid-feed on open. A ResizeObserver on the
// content wrapper re-pins on every growth while the operator is stuck to the
// bottom (or the global auto-scroll FR-62 is ON); scrolling away unsticks as
// before. Shared by ChatView and TransportView.

import { useEffect, useRef } from "react";

export function usePinnedFeed(
  follow: boolean | undefined,
  lastId: string | undefined,
  /**
   * false ⇒ no auto-pinning at all (T108): with a message deep link (FR-75)
   * open, the anchor owns the scroll position — the bottom pin raced the
   * anchor's scrollIntoView on cold loads and won, landing on the newest
   * message instead of the linked one.
   */
  enabled = true,
): {
  feedRef: React.RefObject<HTMLDivElement | null>;
  contentRef: React.RefObject<HTMLDivElement | null>;
  onScroll: () => void;
} {
  const feedRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const pin = (): void => {
    const feed = feedRef.current;
    if (enabled && feed !== null && (follow === true || stickToBottom.current)) {
      feed.scrollTop = feed.scrollHeight;
    }
  };

  // Content growth (initial render, async media, new bubbles) re-pins while
  // stuck — the observer fires once right at observe(), which IS the
  // scroll-on-open. Older-page prepends DO trigger it too, but only when the
  // operator is at the bottom — scrolled-up reading is never yanked.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pin` reads only refs + the follow/enabled props
  useEffect(() => {
    const content = contentRef.current;
    if (content === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    return () => observer.disconnect();
  }, [follow, enabled]);

  // A NEW newest message still pins explicitly (cheap, covers same-height swaps).
  // biome-ignore lint/correctness/useExhaustiveDependencies: lastId IS the trigger
  useEffect(pin, [lastId, follow, enabled]);

  const onScroll = (): void => {
    const feed = feedRef.current;
    if (feed === null) return;
    stickToBottom.current = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40;
  };

  return { feedRef, contentRef, onScroll };
}
