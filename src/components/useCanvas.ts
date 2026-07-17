import { useState, useRef, useCallback, useEffect } from 'react';
import { isDraggingCat } from './physics/colliders';
import { MOBILE_MEDIA_QUERY } from '../lib/breakpoints';
import type { Bounds } from './notesUtils';

const PAN_THRESHOLD = 4;
// Duration of an animated camera move (fit-to-screen, fly-to-note). Short
// enough to feel snappy, long enough to read as motion so the user keeps
// their bearings instead of being teleported.
const FLY_DURATION_MS = 280;
// Breathing room left around the content when framing it, so notes don't sit
// flush against the viewport edge after a fit.
const FIT_PADDING_PX = 80;
// Breathing room kept around a note when scrolling it just into view (reveal),
// so it lands clearly inside the edge rather than flush against it.
const REVEAL_MARGIN_PX = 48;
// Chrome's default zoom-level ladder, in fractional form. Wheel zoom snaps
// to these so 100% is always reachable.
const ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5,
  3.0, 4.0,
] as const;
const MIN_ZOOM = ZOOM_LEVELS[0];
const MAX_ZOOM = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
// Shared zoom bounds. Wheel zoom snaps to ZOOM_LEVELS within this range;
// pinch zoom is continuous but clamps to the same endpoints.
const clampZoom = (zoom: number) =>
  Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
// Wheel-delta units required to advance one zoom level. ~100 matches a single
// mouse-wheel notch in Chrome; trackpads accumulate many small deltas.
const WHEEL_STEP_UNITS = 100;
const TRANSFORM_KEY = 'catodoro-canvas-transform';

type CanvasTransform = {
  x: number;
  y: number;
  zoom: number;
};

const DEFAULT_TRANSFORM: CanvasTransform = { x: 0, y: 0, zoom: 1 };

const loadTransform = (): CanvasTransform => {
  try {
    const raw = localStorage.getItem(TRANSFORM_KEY);
    if (!raw) return DEFAULT_TRANSFORM;
    const parsed = JSON.parse(raw) as Partial<CanvasTransform>;
    const x =
      typeof parsed.x === 'number' && Number.isFinite(parsed.x) ? parsed.x : 0;
    const y =
      typeof parsed.y === 'number' && Number.isFinite(parsed.y) ? parsed.y : 0;
    const zoom =
      typeof parsed.zoom === 'number' && Number.isFinite(parsed.zoom)
        ? clampZoom(parsed.zoom)
        : 1;
    return { x, y, zoom };
  } catch {
    return DEFAULT_TRANSFORM;
  }
};

const closestZoomLevelIndex = (zoom: number) => {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ZOOM_LEVELS.length; i++) {
    const dist = Math.abs(ZOOM_LEVELS[i] - zoom);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
};

// Standard ease-in-out so the camera accelerates out of rest and decelerates
// into its target rather than moving linearly.
const easeInOutCubic = (t: number) =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Camera transform that frames `bounds` within the viewport, centered, with
// `padding` of empty space on every side. Pure so it can be unit-tested and
// reused by any "frame this region" caller (fit-to-screen today; minimap and
// fly-to-note later). Zoom is capped at 1 — we only ever zoom *out* to bring
// scattered notes into view, never *in* past 100% to fill the screen with a
// single small note — then clamped into the supported zoom range.
const computeFitTransform = ({
  bounds,
  viewportWidth,
  viewportHeight,
  padding = 0,
}: {
  bounds: Bounds;
  viewportWidth: number;
  viewportHeight: number;
  padding?: number;
}): CanvasTransform => {
  const contentW = Math.max(1, bounds.maxX - bounds.minX);
  const contentH = Math.max(1, bounds.maxY - bounds.minY);
  const availW = Math.max(1, viewportWidth - padding * 2);
  const availH = Math.max(1, viewportHeight - padding * 2);
  const rawZoom = Math.min(availW / contentW, availH / contentH);
  // Cap at 100% (only ever zoom out to frame scattered notes, never in past
  // 100% to fill the screen with one small note), then snap a fit that rounds
  // to 100% up to exactly 1: notes only drop their scaled (slightly blurry)
  // compositing at zoom===1 and the reset-zoom pill is gated on the rounded
  // readout, so a fit landing at e.g. 0.997 would otherwise look done yet stay
  // blurry with no one-click way back to crisp.
  const capped = Math.min(rawZoom, 1);
  const fitZoom = Math.round(capped * 100) >= 100 ? 1 : capped;
  const zoom = clampZoom(fitZoom);
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;
  return {
    x: viewportWidth / 2 - centerX * zoom,
    y: viewportHeight / 2 - centerY * zoom,
    zoom,
  };
};

// Transform that re-zooms to `zoom` while keeping the world point currently
// under (anchorX, anchorY) pinned to that same screen point — so the content
// under the anchor doesn't appear to slide. The shared math behind
// cursor-anchored wheel zoom and the reset-to-100% control.
const anchoredZoomTransform = ({
  transform,
  anchorX,
  anchorY,
  zoom,
}: {
  transform: CanvasTransform;
  anchorX: number;
  anchorY: number;
  zoom: number;
}): CanvasTransform => {
  const worldX = (anchorX - transform.x) / transform.zoom;
  const worldY = (anchorY - transform.y) / transform.zoom;
  return {
    x: anchorX - worldX * zoom,
    y: anchorY - worldY * zoom,
    zoom,
  };
};

// Screen-space shape of the fingers driving a touch gesture: their centroid
// and, with two fingers, the spread between them. One finger has no spread
// (distance 0 — no zoom signal, pan only). Only the first two points
// contribute; a third finger resting on the screen shouldn't yank the
// centroid around mid-gesture.
type TouchGestureGeometry = {
  centroidX: number;
  centroidY: number;
  distance: number;
};

const touchGestureGeometry = (
  points: readonly { x: number; y: number }[],
): TouchGestureGeometry => {
  const a = points.at(0);
  const b = points.at(1);
  if (!a) return { centroidX: 0, centroidY: 0, distance: 0 };
  if (!b) return { centroidX: a.x, centroidY: a.y, distance: 0 };
  return {
    centroidX: (a.x + b.x) / 2,
    centroidY: (a.y + b.y) / 2,
    distance: Math.hypot(b.x - a.x, b.y - a.y),
  };
};

// Snapshot a gesture re-anchors to whenever its finger count changes, so a
// finger joining or lifting continues the motion from the current view
// instead of jumping.
type TouchGestureBaseline = TouchGestureGeometry & {
  transform: CanvasTransform;
};

// Camera transform continuing a touch gesture from its baseline: the world
// point that sat under the baseline centroid stays pinned under the current
// centroid (drag to pan) while zoom scales by the ratio of finger spread
// (pinch to zoom). With one finger both spreads are 0, the ratio is 1, and
// this reduces to a pure pan. Pinch zoom is continuous — snapping to the
// wheel's ZOOM_LEVELS mid-pinch would make the content stutter under the
// fingers — but clamps to the same endpoints.
const touchGestureTransform = ({
  baseline,
  geometry,
}: {
  baseline: TouchGestureBaseline;
  geometry: TouchGestureGeometry;
}): CanvasTransform => {
  const scale =
    baseline.distance > 0 && geometry.distance > 0
      ? geometry.distance / baseline.distance
      : 1;
  // Re-zoom around the baseline centroid, then follow the centroid's motion.
  const zoomed = anchoredZoomTransform({
    transform: baseline.transform,
    anchorX: baseline.centroidX,
    anchorY: baseline.centroidY,
    zoom: clampZoom(baseline.transform.zoom * scale),
  });
  return {
    x: zoomed.x + (geometry.centroidX - baseline.centroidX),
    y: zoomed.y + (geometry.centroidY - baseline.centroidY),
    zoom: zoomed.zoom,
  };
};

// Live state of one touch sequence on the canvas, from first eligible finger
// down to last finger up.
type TouchGesture = {
  // Latest screen position per participating pointer id.
  points: Map<number, { x: number; y: number }>;
  baseline: TouchGestureBaseline;
  // Past the movement threshold: the gesture owns the camera and the
  // trailing click is suppressed.
  engaged: boolean;
  // Removes the window listeners this gesture attached.
  detach: () => void;
};

// Minimum 1-D shift to bring the span [lo, hi] inside [0, max] with `margin` of
// breathing room on each side. Zero when it's already in range.
const axisShiftIntoView = ({
  lo,
  hi,
  max,
  margin,
}: {
  lo: number;
  hi: number;
  max: number;
  margin: number;
}) => {
  // Too long to show both margins: bring the NEAREST overshot edge to its
  // margin (the near portion the user came from), whichever side it's off.
  // If it already spans the inner viewport, it's as visible as it can be —
  // don't move. Pinning `lo` unconditionally (the old behavior) scrolled an
  // off-left/off-top span to its FAR edge and jolted a span already in view.
  if (hi - lo > max - margin * 2) {
    if (lo > margin) return margin - lo;
    if (hi < max - margin) return max - margin - hi;
    return 0;
  }
  if (lo < margin) return margin - lo;
  if (hi > max - margin) return max - margin - hi;
  return 0;
};

// Minimum pan (zoom unchanged) that scrolls a world-space rect just inside the
// viewport with `margin` px of breathing room — scroll-into-view, not recenter,
// so a revealed note lands near the edge it came from instead of dead-center
// behind the fixed UI column.
const revealRectTransform = ({
  transform,
  rect,
  viewportWidth,
  viewportHeight,
  margin = 0,
}: {
  transform: CanvasTransform;
  rect: Bounds;
  viewportWidth: number;
  viewportHeight: number;
  margin?: number;
}): CanvasTransform => {
  const { zoom } = transform;
  return {
    x:
      transform.x +
      axisShiftIntoView({
        lo: rect.minX * zoom + transform.x,
        hi: rect.maxX * zoom + transform.x,
        max: viewportWidth,
        margin,
      }),
    y:
      transform.y +
      axisShiftIntoView({
        lo: rect.minY * zoom + transform.y,
        hi: rect.maxY * zoom + transform.y,
        max: viewportHeight,
        margin,
      }),
    zoom,
  };
};

const INTERACTIVE_SELECTOR =
  'button, input, textarea, select, option, label, a, [role="button"]';

// True when the element is an editable field or interactive control, i.e.
// somewhere Space should type/activate rather than engage canvas panning.
const isEditableOrInteractive = (el: Element | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true; // standard, layout-aware check
  // Fall back to the reflected attribute: catches a focused node inside a
  // contenteditable host (Tiptap note editor) and works where the DOM impl
  // doesn't compute `isContentEditable` (e.g. jsdom under test).
  return (
    el.closest(
      `${INTERACTIVE_SELECTOR}, [contenteditable=""], [contenteditable="true"]`,
    ) !== null
  );
};

// True when the pointer landed on canvas content (a note / calendar card) or
// an interactive control rather than the bare canvas background. Pan and touch
// gestures never *start* there — those surfaces own their pointer. Shared by
// the mouse and touch paths so the exclusion list can't drift between them.
const startsOnCanvasForeground = (target: HTMLElement) =>
  target.closest('[data-canvas-content="true"]') !== null ||
  target.closest(INTERACTIVE_SELECTOR) !== null;

const isInsideScrollable = (target: EventTarget | null, root: HTMLElement) => {
  let node: Node | null = target instanceof Node ? target : null;
  while (node && node !== root) {
    if (node instanceof HTMLElement) {
      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY;
      const overflowX = style.overflowX;
      const scrollableY =
        (overflowY === 'auto' || overflowY === 'scroll') &&
        node.scrollHeight > node.clientHeight;
      const scrollableX =
        (overflowX === 'auto' || overflowX === 'scroll') &&
        node.scrollWidth > node.clientWidth;
      if (scrollableY || scrollableX) return true;
    }
    node = node.parentNode;
  }
  return false;
};

const useCanvas = () => {
  // Container is tracked in state (via a callback ref) rather than useRef so
  // the wheel-listener effect below re-runs if the element ever changes —
  // a plain useRef would let an empty-deps effect silently miss a remount.
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((el: HTMLDivElement | null) => {
    setContainer(el);
  }, []);
  const [transform, setTransform] = useState<CanvasTransform>(loadTransform);
  const transformRef = useRef(transform);
  transformRef.current = transform;

  // Persist on a 250ms tail so a fast pan or wheel-zoom only writes once
  // when the user settles. Previously every transform tick caused a write,
  // so pan/zoom interactions could fire dozens of writes per second.
  useEffect(() => {
    const handle = window.setTimeout(() => {
      try {
        localStorage.setItem(TRANSFORM_KEY, JSON.stringify(transform));
      } catch {
        // ignore quota / privacy-mode errors
      }
    }, 250);
    return () => window.clearTimeout(handle);
  }, [transform]);

  // Tracks whether the most recent pointer interaction on the container
  // turned into a pan, so the click handler can suppress the click.
  const wasPanningRef = useRef(false);

  // Handle of the in-flight fly-to animation, if any. Held in a ref so manual
  // interaction (pan/zoom) can abort a camera move the moment the user grabs
  // control back, rather than fighting it.
  const flyRafRef = useRef<number | null>(null);
  const cancelFly = useCallback(() => {
    if (flyRafRef.current !== null) {
      cancelAnimationFrame(flyRafRef.current);
      flyRafRef.current = null;
    }
  }, []);
  // Abandon any in-flight animation on unmount so a stray frame can't fire
  // setTransform after teardown.
  useEffect(() => cancelFly, [cancelFly]);

  // Pan is gated on holding Space (a "hand tool"), not Ctrl: on macOS
  // Ctrl+click is an OS right-click that steals the mousedown. Space isn't a
  // pointer modifier, so we track its held state here and read it at
  // pointer-down. Only read at the start of a drag, so releasing Space
  // mid-drag still lets the in-progress pan finish.
  const spaceHeldRef = useRef(false);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return;
      // Let Space type / activate when focus is in an editable or interactive
      // element — only engage pan mode from the bare page.
      if (isEditableOrInteractive(document.activeElement)) return;
      e.preventDefault(); // stop the page from scrolling on Space
      spaceHeldRef.current = true;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') spaceHeldRef.current = false;
    };
    // Space held while the window loses focus would never receive keyup.
    const onBlur = () => {
      spaceHeldRef.current = false;
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // --- Touch pan & pinch-zoom ----------------------------------------------
  // One gesture object per touch sequence: created on the first eligible
  // touch, destroyed when the last finger lifts. Mirrors the mouse pan's
  // listeners-per-interaction pattern, extended to coordinate multiple
  // pointers — one finger pans, two fingers pinch-zoom.
  const touchGestureRef = useRef<TouchGesture | null>(null);

  // Baseline snapshot at the current camera and finger layout. Recaptured
  // whenever the finger count changes so a finger joining or lifting
  // continues the motion from the current view instead of jumping it.
  const captureTouchBaseline = useCallback(
    (points: TouchGesture['points']): TouchGestureBaseline => ({
      transform: transformRef.current,
      ...touchGestureGeometry([...points.values()]),
    }),
    [],
  );

  // Detach an in-flight touch gesture's window listeners on unmount so a
  // stray move can't fire setTransform after teardown.
  useEffect(
    () => () => {
      touchGestureRef.current?.detach();
      touchGestureRef.current = null;
    },
    [],
  );

  const handleTouchPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // The mobile layout scrolls natively and keeps notes in a drawer — no
      // canvas to pan. Touch gestures only exist where the desktop layout
      // renders the free canvas (tablets, touch laptops).
      if (window.matchMedia(MOBILE_MEDIA_QUERY).matches) return;
      // Native scrolling keeps priority inside scrollable regions (e.g. the
      // expanded task list) for every finger — joining one to the gesture
      // would scroll the region and move the camera at once.
      if (isInsideScrollable(e.target, e.currentTarget as HTMLElement)) return;

      const joined = touchGestureRef.current;
      if (joined) {
        // A finger joining an in-flight gesture means pinch, wherever it
        // lands — unlike a first finger it may land on canvas foreground.
        // That's safe: note/calendar drags only start from their header and
        // resize handles, whose pointerdown handlers stopPropagation and so
        // never reach here, and a non-primary finger can't click a control
        // on release.
        joined.points.set(e.pointerId, { x: e.clientX, y: e.clientY });
        joined.baseline = captureTouchBaseline(joined.points);
        return;
      }

      // A first finger only starts a gesture from the bare canvas/background
      // (same rule as the mouse pan) — notes and interactive controls keep
      // their own touch behavior.
      if (startsOnCanvasForeground(e.target as HTMLElement)) return;

      const points = new Map([[e.pointerId, { x: e.clientX, y: e.clientY }]]);
      const gesture: TouchGesture = {
        points,
        baseline: captureTouchBaseline(points),
        engaged: false,
        detach: () => {},
      };

      const handleMove = (ev: PointerEvent) => {
        if (!gesture.points.has(ev.pointerId)) return;
        gesture.points.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
        // A cat drag outranks the camera: a finger that landed on a cat is
        // carrying it, so hold the camera still but keep the baseline fresh —
        // when the cat is dropped the pan resumes from here without a jump.
        if (isDraggingCat()) {
          gesture.baseline = captureTouchBaseline(gesture.points);
          return;
        }
        const geometry = touchGestureGeometry([...gesture.points.values()]);
        if (!gesture.engaged) {
          // Movement must clear a small threshold so taps (one- or
          // two-finger) stay taps and don't twitch the camera or cancel a
          // fly. For a pinch the spread change counts too, so a zoom with a
          // motionless centroid still engages.
          const moved = Math.hypot(
            geometry.centroidX - gesture.baseline.centroidX,
            geometry.centroidY - gesture.baseline.centroidY,
          );
          const spread = Math.abs(
            geometry.distance - gesture.baseline.distance,
          );
          if (moved < PAN_THRESHOLD && spread < PAN_THRESHOLD) return;
          gesture.engaged = true;
          cancelFly();
        }
        // Marked on every frame, not just at engagement: a finger joining
        // mid-gesture routes through handlePointerDown, which clears the
        // flag only between sequences.
        wasPanningRef.current = true;
        const next = touchGestureTransform({
          baseline: gesture.baseline,
          geometry,
        });
        const current = transformRef.current;
        // Skip no-op frames (zoom pinned at a clamp bound, fingers resting)
        // so input-frequency moves don't re-render the canvas for nothing.
        if (
          next.x === current.x &&
          next.y === current.y &&
          next.zoom === current.zoom
        ) {
          return;
        }
        setTransform(next);
      };

      const handleEnd = (ev: PointerEvent) => {
        if (!gesture.points.delete(ev.pointerId)) return;
        // pointercancel means the platform claimed this touch (edge swipe,
        // palm rejection) — bail out of the whole gesture rather than letting
        // the remaining fingers fight the browser.
        if (ev.type !== 'pointercancel' && gesture.points.size > 0) {
          gesture.baseline = captureTouchBaseline(gesture.points);
          return;
        }
        gesture.detach();
        touchGestureRef.current = null;
      };

      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleEnd);
      window.addEventListener('pointercancel', handleEnd);
      gesture.detach = () => {
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleEnd);
        window.removeEventListener('pointercancel', handleEnd);
      };
      touchGestureRef.current = gesture;
    },
    [cancelFly, captureTouchBaseline],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // A finished pan whose trailing click never fired (touch pans don't
      // produce one) must not swallow this interaction's click — clear the
      // stale flag at the start of every fresh pointer sequence. Skipped
      // while a touch gesture is in flight: a joining finger is part of the
      // same interaction, not a new one.
      if (!touchGestureRef.current) wasPanningRef.current = false;
      if (e.pointerType === 'touch') {
        handleTouchPointerDown(e);
        return;
      }
      if (e.button !== 0) return;
      // Pens get no gesture mapping (a stylus is for precision, not panning);
      // mouse pan continues below.
      if (e.pointerType !== 'mouse') return;
      // Pan requires Space held — keeps normal clicks/drags free for selection
      // and interactive UI.
      if (!spaceHeldRef.current) return;
      // Ignore drags that started on interactive UI (notes, buttons, inputs).
      // Pan only initiates from the bare canvas/background.
      if (startsOnCanvasForeground(e.target as HTMLElement)) return;

      // Suppress the native text-selection that a mousedown-drag would otherwise
      // start across the title / timer / task list.
      e.preventDefault();

      const startScreenX = e.clientX;
      const startScreenY = e.clientY;
      const originX = transformRef.current.x;
      const originY = transformRef.current.y;
      let active = false;
      let aborted = false;

      const handleMove = (ev: PointerEvent) => {
        if (aborted) return;
        const dx = ev.clientX - startScreenX;
        const dy = ev.clientY - startScreenY;
        if (!active) {
          if (Math.hypot(dx, dy) < PAN_THRESHOLD) return;
          if (isDraggingCat()) {
            aborted = true;
            return;
          }
          active = true;
          cancelFly();
          wasPanningRef.current = true;
          document.body.style.cursor = 'grabbing';
          document.body.style.userSelect = 'none';
          // Clear any selection the user already had before starting to pan.
          window.getSelection()?.removeAllRanges();
        }
        setTransform((t) => ({ ...t, x: originX + dx, y: originY + dy }));
      };

      const handleUp = () => {
        window.removeEventListener('pointermove', handleMove);
        window.removeEventListener('pointerup', handleUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };

      window.addEventListener('pointermove', handleMove);
      window.addEventListener('pointerup', handleUp);
    },
    [cancelFly, handleTouchPointerDown],
  );

  // Wheel must be a non-passive native listener so we can preventDefault.
  // Re-runs whenever the container element changes so a remount re-attaches
  // the listener instead of silently losing it.
  useEffect(() => {
    if (!container) return;
    // Accumulator lets fine-grained trackpad deltas add up to one full level
    // step, while a single mouse-wheel notch (deltaY ~= 100) advances by one.
    let wheelAccum = 0;

    const onWheel = (e: WheelEvent) => {
      // Zoom requires Ctrl held — leaves regular wheel events for native
      // scrolling inside any scrollable region.
      if (!e.ctrlKey) return;
      if (isInsideScrollable(e.target, container)) return;
      e.preventDefault();
      // Reset accumulator when the user reverses scroll direction so changes
      // of mind feel responsive.
      if (wheelAccum !== 0 && Math.sign(e.deltaY) !== Math.sign(wheelAccum)) {
        wheelAccum = 0;
      }
      wheelAccum += e.deltaY;
      const steps = Math.trunc(wheelAccum / WHEEL_STEP_UNITS);
      if (steps === 0) return;
      wheelAccum -= steps * WHEEL_STEP_UNITS;

      const { zoom } = transformRef.current;
      const currentIdx = closestZoomLevelIndex(zoom);
      // Positive deltaY = scroll down = zoom out = lower index.
      const nextIdx = Math.max(
        0,
        Math.min(ZOOM_LEVELS.length - 1, currentIdx - steps),
      );
      const nextZoom = ZOOM_LEVELS[nextIdx];
      if (nextZoom === zoom) return;
      cancelFly();
      setTransform(
        anchoredZoomTransform({
          transform: transformRef.current,
          anchorX: e.clientX,
          anchorY: e.clientY,
          zoom: nextZoom,
        }),
      );
    };
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, [container, cancelFly]);

  const screenToWorld = useCallback((sx: number, sy: number) => {
    const { x, y, zoom } = transformRef.current;
    return { x: (sx - x) / zoom, y: (sy - y) / zoom };
  }, []);

  // Animate the camera from its current transform to `target` over
  // FLY_DURATION_MS. Honors prefers-reduced-motion (jumps instantly) and is
  // the single primitive every "go look over there" feature reuses
  // (fit-to-screen now; minimap, omnibar and edge indicators next).
  const flyTo = useCallback(
    (target: CanvasTransform) => {
      cancelFly();
      const start = transformRef.current;
      if (
        start.x === target.x &&
        start.y === target.y &&
        start.zoom === target.zoom
      ) {
        return;
      }
      if (prefersReducedMotion()) {
        setTransform(target);
        return;
      }
      const startTime = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - startTime) / FLY_DURATION_MS);
        const eased = easeInOutCubic(progress);
        setTransform({
          x: start.x + (target.x - start.x) * eased,
          y: start.y + (target.y - start.y) * eased,
          zoom: start.zoom + (target.zoom - start.zoom) * eased,
        });
        flyRafRef.current = progress < 1 ? requestAnimationFrame(step) : null;
      };
      flyRafRef.current = requestAnimationFrame(step);
    },
    [cancelFly],
  );

  // Reset zoom to 100% around the viewport center, keeping the centered point
  // fixed rather than jumping the pan back to origin. No-op when already at
  // 100%.
  const resetZoom = useCallback(() => {
    if (transformRef.current.zoom === 1) return;
    flyTo(
      anchoredZoomTransform({
        transform: transformRef.current,
        anchorX: window.innerWidth / 2,
        anchorY: window.innerHeight / 2,
        zoom: 1,
      }),
    );
  }, [flyTo]);

  // Scroll a world-space rect just into view at the current zoom (no reframe),
  // so a revealed note lands near the edge it came from rather than dead-center
  // behind the fixed UI column. No-op when rect is null.
  const revealRect = useCallback(
    (rect: Bounds | null) => {
      if (!rect) return;
      flyTo(
        revealRectTransform({
          transform: transformRef.current,
          rect,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          margin: REVEAL_MARGIN_PX,
        }),
      );
    },
    [flyTo],
  );

  // Frame every note within the viewport with padding, centered. No-op when
  // there's nothing to frame (bounds === null).
  const fitToContent = useCallback(
    (bounds: Bounds | null) => {
      if (!bounds) return;
      flyTo(
        computeFitTransform({
          bounds,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          padding: FIT_PADDING_PX,
        }),
      );
    },
    [flyTo],
  );

  // Keep the world point at the viewport center fixed as the viewport resizes,
  // so notes don't drift off-screen when the window changes size (or DevTools
  // docks/undocks). Shifting by half the size delta is zoom-independent. Only
  // runs on desktop — the mobile layout has no free canvas, and the URL bar
  // collapsing on scroll would otherwise nudge the dot grid on every scroll.
  useEffect(() => {
    let prevW = window.innerWidth;
    let prevH = window.innerHeight;
    let prevMobile = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
    const onResize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const dw = w - prevW;
      const dh = h - prevH;
      const wasMobile = prevMobile;
      prevW = w;
      prevH = h;
      prevMobile = window.matchMedia(MOBILE_MEDIA_QUERY).matches;
      if (dw === 0 && dh === 0) return;
      // No free canvas on mobile (notes live in a drawer), so don't compensate
      // there. Crucially, also skip the first desktop frame after a mobile
      // stretch: that delta spans the whole mobile excursion, and applying half
      // of it would permanently drift the canvas after a desktop->mobile->
      // desktop round-trip (e.g. snapping a window to half-screen and back).
      if (prevMobile || wasMobile) return;
      // A fit/reveal fly is heading to an absolute target; a mid-flight resize
      // shouldn't cancel it and freeze the camera half-framed. Let it finish
      // (the small size delta barely shifts the target) instead of nudging.
      if (flyRafRef.current !== null) return;
      setTransform((t) => ({ ...t, x: t.x + dw / 2, y: t.y + dh / 2 }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return {
    transform,
    containerRef,
    handlePointerDown,
    screenToWorld,
    wasPanningRef,
    fitToContent,
    revealRect,
    resetZoom,
  };
};

export {
  useCanvas,
  loadTransform,
  closestZoomLevelIndex,
  computeFitTransform,
  anchoredZoomTransform,
  revealRectTransform,
  touchGestureGeometry,
  touchGestureTransform,
  isEditableOrInteractive,
  ZOOM_LEVELS,
};
export type { CanvasTransform };
