// Dragging the console window (§12.9.4, T318). The one rule worth pinning is
// that the window cannot be dragged out of reach: whatever the pointer does,
// the box stays whole inside the viewport. DOM-free — Console.tsx only feeds
// these rules a rect and a pointer delta.

import { describe, expect, test } from "bun:test";
import { ORIGIN, clampOffset, dragBounds, dragTo } from "../src/window-drag";

const VIEW = { width: 1000, height: 800 };
/** A 600×400 window sitting centred, never dragged. */
const CENTRED = { left: 200, top: 200, width: 600, height: 400 };

describe("how far the window may go (dragBounds)", () => {
  test("a centred window may reach every edge and no further", () => {
    const bounds = dragBounds(CENTRED, ORIGIN, VIEW);
    expect(bounds).toEqual({ minX: -200, maxX: 200, minY: -200, maxY: 200 });
  });

  // The rect handed in ALREADY carries the offset — bounds computed from it
  // must not drift as the window moves, or a long drag would slowly escape.
  test("bounds are the same whether the window has been dragged or not", () => {
    const moved = { ...CENTRED, left: CENTRED.left + 150, top: CENTRED.top - 90 };
    expect(dragBounds(moved, { x: 150, y: -90 }, VIEW)).toEqual(dragBounds(CENTRED, ORIGIN, VIEW));
  });

  test("a window as wide as the viewport may only move vertically", () => {
    const wide = { left: 0, top: 200, width: 1000, height: 400 };
    const bounds = dragBounds(wide, ORIGIN, VIEW);
    expect(bounds.minX).toBe(0);
    expect(bounds.maxX).toBe(0);
    expect(bounds.maxY).toBe(200);
  });
});

describe("where a drag lands (dragTo)", () => {
  const bounds = dragBounds(CENTRED, ORIGIN, VIEW);

  test("a short drag lands exactly where the pointer went", () => {
    expect(dragTo(ORIGIN, 40, -25, bounds)).toEqual({ x: 40, y: -25 });
  });

  test("a drag off the screen stops at the edge, not past it", () => {
    expect(dragTo(ORIGIN, 5000, 5000, bounds)).toEqual({ x: 200, y: 200 });
    expect(dragTo(ORIGIN, -5000, -5000, bounds)).toEqual({ x: -200, y: -200 });
  });

  test("a drag continues from where the last one stopped", () => {
    const first = dragTo(ORIGIN, 120, 0, bounds);
    expect(dragTo(first, 30, 0, bounds)).toEqual({ x: 150, y: 0 });
  });
});

describe("a viewport too small for the window", () => {
  // Bounds cross here (maxY < minY). The LOW bound wins on purpose: a window
  // taller than the screen keeps its TOP edge on screen, because the title bar
  // is what the next drag has to grab — pinning the bottom would bury it.
  const tall = { left: 200, top: 0, width: 600, height: 1200 };
  const bounds = dragBounds(tall, ORIGIN, VIEW);

  test("the crossing bounds do not flip the window out of reach", () => {
    expect(bounds.maxY).toBeLessThan(bounds.minY);
    expect(clampOffset({ x: 0, y: 300 }, bounds)).toEqual({ x: 0, y: 0 });
    expect(clampOffset({ x: 0, y: -300 }, bounds)).toEqual({ x: 0, y: 0 });
  });
});

describe("re-clamping after the viewport changes", () => {
  // A window parked at the right edge must not be left hanging outside it when
  // the window shrinks — Console.tsx re-clamps on resize and on leaving full
  // screen with exactly this call.
  // The rect is re-read AFTER the browser has laid the page out again, so it is
  // the box as it now stands — same size here, re-centred in the narrower
  // viewport, still carrying the old offset.
  test("a window parked at an edge is pulled back in when the screen shrinks", () => {
    const parked = { x: 200, y: 0 };
    const smaller = { width: 900, height: 800 };
    const boxNow = { ...CENTRED, left: (smaller.width - CENTRED.width) / 2 + parked.x };
    expect(clampOffset(parked, dragBounds(boxNow, parked, smaller))).toEqual({ x: 150, y: 0 });
  });

  test("an untouched window stays untouched — the resting spot is always legal", () => {
    const view = { width: 700, height: 500 };
    const centred = { left: 50, top: 50, width: 600, height: 400 };
    expect(clampOffset(ORIGIN, dragBounds(centred, ORIGIN, view))).toEqual(ORIGIN);
  });
});
