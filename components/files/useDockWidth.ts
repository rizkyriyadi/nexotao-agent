"use client";

/* The dock's width, dragged and remembered.
 *
 * Kept out of the component because the drag has to survive the pointer leaving
 * the panel — you throw the handle across the window and the width should keep
 * up — which means listeners on `window`, not on the element. */

import { useCallback, useEffect, useRef, useState } from "react";

export const DOCK_MIN = 260;
/** Past roughly half the window the conversation stops being readable, and the
 *  dock exists to sit *beside* it. Capped against the viewport rather than a
 *  constant so the limit means the same thing on a laptop and a 4K panel. */
export const DOCK_MAX_FRACTION = 0.62;
export const DOCK_DEFAULT = 340;

const KEY = "nexotao.dock.width";

export function clampWidth(width: number, viewport: number) {
  // `NaN` passes straight through `Math.min`/`Math.max`, and a NaN width sets
  // the panel to zero — collapsed, with the handle that would fix it gone too.
  // A stored value parsed from a corrupt `localStorage` entry is exactly how
  // that arrives.
  if (Number.isNaN(width)) return DOCK_MIN;
  const room = Number.isNaN(viewport) ? 0 : viewport;
  const max = Math.max(DOCK_MIN, Math.round(room * DOCK_MAX_FRACTION));
  return Math.min(max, Math.max(DOCK_MIN, Math.round(width)));
}

export function useDockWidth() {
  const [width, setWidth] = useState(DOCK_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const stored = Number(localStorage.getItem(KEY));
    if (Number.isFinite(stored) && stored > 0) setWidth(clampWidth(stored, window.innerWidth));
  }, []);

  // A window narrowed after the fact can leave a stored width wider than the
  // cap, which pushes the conversation off-screen with no way back.
  useEffect(() => {
    const onResize = () => setWidth((w) => clampWidth(w, window.innerWidth));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const startDrag = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    setDragging(true);
    const startX = event.clientX;
    let startWidth = 0;
    setWidth((w) => { startWidth = w; return w; });

    // The dock is on the right, so dragging left widens it.
    const onMove = (move: PointerEvent) => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        setWidth(clampWidth(startWidth + (startX - move.clientX), window.innerWidth));
      });
    };
    const onUp = () => {
      setDragging(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setWidth((w) => { try { localStorage.setItem(KEY, String(w)); } catch { /* private mode */ } return w; });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, []);

  /** Arrow keys move the handle too. A drag-only resizer is unreachable without
   *  a pointer, and this one is a real control, not decoration. */
  const nudge = useCallback((delta: number) => {
    setWidth((w) => {
      const next = clampWidth(w + delta, window.innerWidth);
      try { localStorage.setItem(KEY, String(next)); } catch { /* private mode */ }
      return next;
    });
  }, []);

  return { width, dragging, startDrag, nudge };
}
