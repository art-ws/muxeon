// Dragging the console window by its title bar (§12.9.4, T318 — operator
// request). The geometry lives here, pure and DOM-free, so `bun test` covers
// the one rule that matters — a window can never be dragged out of reach —
// without a browser: `Console.tsx` only feeds it rects and pointer deltas.
//
// The window is positioned by an OFFSET from where the overlay centres it, not
// by absolute coordinates: the box keeps its own sizing rules (§12.9.4), and
// "never dragged" stays the honest {0, 0}.

/** How far the window has been dragged from where the overlay centres it. */
export interface Offset {
  readonly x: number;
  readonly y: number;
}

/** The resting position — dead centre, the way the window opens. */
export const ORIGIN: Offset = { x: 0, y: 0 };

/** The offsets a drag may still reach. */
export interface Bounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Just the numbers `DOMRect` and `window` supply — no DOM types in the rules. */
export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/**
 * The offsets that keep the window WHOLE inside the viewport. A window dragged
 * past an edge is a window that has to be reopened to be used again, so the box
 * may go anywhere it still fits and no further.
 *
 * `box` is the element's CURRENT rect, which already carries `current`;
 * subtracting it recovers where the overlay would place the box on its own, and
 * the bounds are expressed against that resting position.
 */
export function dragBounds(box: Box, current: Offset, view: Viewport): Bounds {
  const left = box.left - current.x;
  const top = box.top - current.y;
  return {
    minX: flat(-left),
    maxX: flat(view.width - box.width - left),
    minY: flat(-top),
    maxY: flat(view.height - box.height - top),
  };
}

/** `-0` is what `-left` yields for a window already flush against an edge. It
 *  clamps the same, but it travels: into the offset, then into a
 *  `translate(-0px, …)`. Flatten it here, once. */
const flat = (value: number): number => (value === 0 ? 0 : value);

/**
 * Clamp that survives a box BIGGER than its viewport: there the two bounds cross
 * (`maxX < minX`), and the LOW one wins — a window too tall for the screen keeps
 * its top edge on screen rather than its bottom, because the title bar is what
 * the next drag needs to grab.
 */
export const between = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), Math.max(low, high));

export const clampOffset = (offset: Offset, bounds: Bounds): Offset => ({
  x: between(offset.x, bounds.minX, bounds.maxX),
  y: between(offset.y, bounds.minY, bounds.maxY),
});

/** Where a drag lands: its start offset plus the pointer's travel, clamped. */
export const dragTo = (from: Offset, dx: number, dy: number, bounds: Bounds): Offset =>
  clampOffset({ x: from.x + dx, y: from.y + dy }, bounds);
