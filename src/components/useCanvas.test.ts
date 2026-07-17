import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadTransform,
  closestZoomLevelIndex,
  computeFitTransform,
  anchoredZoomTransform,
  revealRectTransform,
  touchGestureGeometry,
  touchGestureTransform,
  isEditableOrInteractive,
  ZOOM_LEVELS,
} from './useCanvas';

const TRANSFORM_KEY = 'catodoro-canvas-transform';

beforeEach(() => {
  localStorage.clear();
});

describe('loadTransform', () => {
  it('returns the default when nothing is stored', () => {
    expect(loadTransform()).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('returns the default when stored JSON is malformed', () => {
    localStorage.setItem(TRANSFORM_KEY, '{not json');
    expect(loadTransform()).toEqual({ x: 0, y: 0, zoom: 1 });
  });

  it('round-trips a stored transform', () => {
    localStorage.setItem(
      TRANSFORM_KEY,
      JSON.stringify({ x: 100, y: -50, zoom: 1.5 }),
    );
    expect(loadTransform()).toEqual({ x: 100, y: -50, zoom: 1.5 });
  });

  it('falls back to 0 for non-finite x/y', () => {
    localStorage.setItem(
      TRANSFORM_KEY,
      JSON.stringify({ x: 'oops', y: NaN, zoom: 1 }),
    );
    const out = loadTransform();
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
  });

  it('clamps zoom into [MIN_ZOOM, MAX_ZOOM]', () => {
    const min = ZOOM_LEVELS[0];
    const max = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];
    localStorage.setItem(
      TRANSFORM_KEY,
      JSON.stringify({ x: 0, y: 0, zoom: 9999 }),
    );
    expect(loadTransform().zoom).toBe(max);
    localStorage.setItem(
      TRANSFORM_KEY,
      JSON.stringify({ x: 0, y: 0, zoom: 0.0001 }),
    );
    expect(loadTransform().zoom).toBe(min);
  });

  it('falls back to zoom=1 for non-finite zoom', () => {
    localStorage.setItem(
      TRANSFORM_KEY,
      JSON.stringify({ x: 0, y: 0, zoom: null }),
    );
    expect(loadTransform().zoom).toBe(1);
  });
});

describe('closestZoomLevelIndex', () => {
  it('snaps exactly to a known zoom level', () => {
    expect(closestZoomLevelIndex(1.0)).toBe(ZOOM_LEVELS.indexOf(1.0));
  });

  it('rounds to the nearest level for in-between values', () => {
    // 1.05 is between 1.0 and 1.1 → closer to 1.1? actually equidistant.
    // Pick 1.04 which is unambiguously closer to 1.0.
    expect(ZOOM_LEVELS[closestZoomLevelIndex(1.04)]).toBe(1.0);
    expect(ZOOM_LEVELS[closestZoomLevelIndex(1.7)]).toBe(1.75);
  });

  it('returns first index for values below MIN', () => {
    expect(closestZoomLevelIndex(0.01)).toBe(0);
  });

  it('returns last index for values above MAX', () => {
    expect(closestZoomLevelIndex(99)).toBe(ZOOM_LEVELS.length - 1);
  });
});

describe('isEditableOrInteractive', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('returns false for null', () => {
    expect(isEditableOrInteractive(null)).toBe(false);
  });

  it('returns false for a bare div', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(isEditableOrInteractive(div)).toBe(false);
  });

  it('returns true for a button and elements inside it', () => {
    const button = document.createElement('button');
    const span = document.createElement('span');
    button.appendChild(span);
    document.body.appendChild(button);
    expect(isEditableOrInteractive(button)).toBe(true);
    expect(isEditableOrInteractive(span)).toBe(true);
  });

  it('returns true for inputs, textareas, and links', () => {
    for (const tag of ['input', 'textarea', 'a'] as const) {
      const el = document.createElement(tag);
      document.body.appendChild(el);
      expect(isEditableOrInteractive(el)).toBe(true);
    }
  });

  it('returns true for elements with role="button"', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'button');
    document.body.appendChild(el);
    expect(isEditableOrInteractive(el)).toBe(true);
  });

  it('returns true for a contenteditable host and nodes inside it', () => {
    // Mirrors how Tiptap renders the note editor: a div carrying the
    // literal contenteditable attribute.
    const host = document.createElement('div');
    host.setAttribute('contenteditable', 'true');
    const child = document.createElement('span');
    host.appendChild(child);
    document.body.appendChild(host);
    expect(isEditableOrInteractive(host)).toBe(true);
    expect(isEditableOrInteractive(child)).toBe(true);
  });
});

describe('computeFitTransform', () => {
  const MIN = ZOOM_LEVELS[0];

  it('centers content and never zooms in past 100% for small content', () => {
    const t = computeFitTransform({
      bounds: { minX: 0, minY: 0, maxX: 200, maxY: 160 },
      viewportWidth: 1000,
      viewportHeight: 800,
    });
    expect(t.zoom).toBe(1);
    // Content center (100, 80) must land at the viewport center (500, 400).
    expect(t.x + 100 * t.zoom).toBeCloseTo(500);
    expect(t.y + 80 * t.zoom).toBeCloseTo(400);
  });

  it('zooms out to fit oversized content within the padded viewport', () => {
    const padding = 100;
    const t = computeFitTransform({
      bounds: { minX: 0, minY: 0, maxX: 2000, maxY: 1000 },
      viewportWidth: 1000,
      viewportHeight: 800,
      padding,
    });
    // Limiting axis is width: (1000 - 2*100) / 2000 = 0.4.
    expect(t.zoom).toBeCloseTo(0.4);
    // Scaled content must fit inside the padded area on both axes.
    expect(2000 * t.zoom).toBeLessThanOrEqual(1000 - 2 * padding + 0.001);
    expect(1000 * t.zoom).toBeLessThanOrEqual(800 - 2 * padding + 0.001);
    // Still centered.
    expect(t.x + 1000 * t.zoom).toBeCloseTo(500);
    expect(t.y + 500 * t.zoom).toBeCloseTo(400);
  });

  it('clamps zoom to MIN_ZOOM for content too large to ever fit', () => {
    const t = computeFitTransform({
      bounds: { minX: 0, minY: 0, maxX: 10000, maxY: 10000 },
      viewportWidth: 1000,
      viewportHeight: 800,
    });
    expect(t.zoom).toBe(MIN);
  });

  it('keeps content centered regardless of negative-origin bounds', () => {
    const t = computeFitTransform({
      bounds: { minX: -300, minY: -100, maxX: -100, maxY: 100 },
      viewportWidth: 800,
      viewportHeight: 600,
    });
    const centerX = (-300 + -100) / 2;
    const centerY = (-100 + 100) / 2;
    expect(t.x + centerX * t.zoom).toBeCloseTo(400);
    expect(t.y + centerY * t.zoom).toBeCloseTo(300);
  });
});

describe('anchoredZoomTransform', () => {
  it('pins the world point under the anchor to the same screen point', () => {
    const transform = { x: 30, y: -10, zoom: 2 };
    const anchorX = 400;
    const anchorY = 300;
    const out = anchoredZoomTransform({ transform, anchorX, anchorY, zoom: 1 });
    const worldX = (anchorX - transform.x) / transform.zoom;
    const worldY = (anchorY - transform.y) / transform.zoom;
    // The same world point must still map to the anchor under the new transform.
    expect(worldX * out.zoom + out.x).toBeCloseTo(anchorX);
    expect(worldY * out.zoom + out.y).toBeCloseTo(anchorY);
    expect(out.zoom).toBe(1);
  });

  it('computes the expected transform for a concrete reset-to-100%', () => {
    const out = anchoredZoomTransform({
      transform: { x: 0, y: 0, zoom: 2 },
      anchorX: 100,
      anchorY: 100,
      zoom: 1,
    });
    expect(out).toEqual({ x: 50, y: 50, zoom: 1 });
  });

  it('leaves the pan unchanged when the zoom is unchanged', () => {
    const transform = { x: 12, y: 34, zoom: 1.5 };
    const out = anchoredZoomTransform({
      transform,
      anchorX: 200,
      anchorY: 150,
      zoom: 1.5,
    });
    expect(out.x).toBeCloseTo(transform.x);
    expect(out.y).toBeCloseTo(transform.y);
    expect(out.zoom).toBe(1.5);
  });
});

describe('touchGestureGeometry', () => {
  it('returns zeros for no fingers', () => {
    expect(touchGestureGeometry([])).toEqual({
      centroidX: 0,
      centroidY: 0,
      distance: 0,
    });
  });

  it('returns the point itself with zero distance for one finger', () => {
    expect(touchGestureGeometry([{ x: 120, y: 80 }])).toEqual({
      centroidX: 120,
      centroidY: 80,
      distance: 0,
    });
  });

  it('returns the midpoint and spread for two fingers', () => {
    const out = touchGestureGeometry([
      { x: 100, y: 100 },
      { x: 200, y: 100 },
    ]);
    expect(out.centroidX).toBe(150);
    expect(out.centroidY).toBe(100);
    expect(out.distance).toBe(100);
  });

  it('ignores a third finger resting on the screen', () => {
    const twoFingers = touchGestureGeometry([
      { x: 100, y: 100 },
      { x: 200, y: 200 },
    ]);
    const threeFingers = touchGestureGeometry([
      { x: 100, y: 100 },
      { x: 200, y: 200 },
      { x: 999, y: 999 },
    ]);
    expect(threeFingers).toEqual(twoFingers);
  });
});

describe('touchGestureTransform', () => {
  const MIN = ZOOM_LEVELS[0];
  const MAX = ZOOM_LEVELS[ZOOM_LEVELS.length - 1];

  it('pans by the centroid delta when the spread is unchanged', () => {
    const baseline = {
      transform: { x: 10, y: 20, zoom: 1.5 },
      centroidX: 100,
      centroidY: 100,
      distance: 120,
    };
    const out = touchGestureTransform({
      baseline,
      geometry: { centroidX: 130, centroidY: 60, distance: 120 },
    });
    expect(out).toEqual({ x: 40, y: -20, zoom: 1.5 });
  });

  it('reduces to a pure pan for single-finger geometry (zero spread)', () => {
    const baseline = {
      transform: { x: -5, y: 15, zoom: 0.5 },
      centroidX: 200,
      centroidY: 300,
      distance: 0,
    };
    const out = touchGestureTransform({
      baseline,
      geometry: { centroidX: 250, centroidY: 280, distance: 0 },
    });
    expect(out).toEqual({ x: 45, y: -5, zoom: 0.5 });
  });

  it('zooms by the spread ratio, pinning the baseline world point under the centroid', () => {
    const baseline = {
      transform: { x: 30, y: -10, zoom: 1 },
      centroidX: 400,
      centroidY: 300,
      distance: 100,
    };
    const geometry = { centroidX: 420, centroidY: 310, distance: 200 };
    const out = touchGestureTransform({ baseline, geometry });
    expect(out.zoom).toBe(2);
    // The world point under the baseline centroid must map to the current
    // centroid under the new transform.
    const worldX = (baseline.centroidX - 30) / 1;
    const worldY = (baseline.centroidY - -10) / 1;
    expect(worldX * out.zoom + out.x).toBeCloseTo(geometry.centroidX);
    expect(worldY * out.zoom + out.y).toBeCloseTo(geometry.centroidY);
  });

  it('clamps zoom at the supported bounds and still anchors correctly', () => {
    const baseline = {
      transform: { x: 0, y: 0, zoom: 1 },
      centroidX: 500,
      centroidY: 400,
      distance: 100,
    };
    const zoomedIn = touchGestureTransform({
      baseline,
      geometry: { centroidX: 500, centroidY: 400, distance: 10000 },
    });
    expect(zoomedIn.zoom).toBe(MAX);
    const zoomedOut = touchGestureTransform({
      baseline,
      geometry: { centroidX: 500, centroidY: 400, distance: 1 },
    });
    expect(zoomedOut.zoom).toBe(MIN);
    // Anchoring holds at the clamped zoom: the world point under the (fixed)
    // centroid stays put.
    expect(500 * zoomedOut.zoom + zoomedOut.x).toBeCloseTo(500);
    expect(400 * zoomedOut.zoom + zoomedOut.y).toBeCloseTo(400);
  });

  it('treats a spread appearing mid-gesture (0 -> positive) as no zoom change', () => {
    // Guards the 1-finger -> 2-finger transition before a rebaseline lands:
    // a zero baseline distance must not divide, it must pan only.
    const baseline = {
      transform: { x: 0, y: 0, zoom: 2 },
      centroidX: 100,
      centroidY: 100,
      distance: 0,
    };
    const out = touchGestureTransform({
      baseline,
      geometry: { centroidX: 110, centroidY: 100, distance: 80 },
    });
    expect(out.zoom).toBe(2);
    expect(out.x).toBe(10);
    expect(out.y).toBe(0);
  });
});

describe('revealRectTransform', () => {
  const VIEWPORT = { viewportWidth: 1000, viewportHeight: 800 };
  const MARGIN = 48;
  // Screen-space rect of `rect` under `transform`.
  const screenRect = (
    rect: { minX: number; minY: number; maxX: number; maxY: number },
    t: { x: number; y: number; zoom: number },
  ) => ({
    left: rect.minX * t.zoom + t.x,
    top: rect.minY * t.zoom + t.y,
    right: rect.maxX * t.zoom + t.x,
    bottom: rect.maxY * t.zoom + t.y,
  });

  it('does not move a rect already comfortably in view', () => {
    const transform = { x: 0, y: 0, zoom: 1 };
    const rect = { minX: 400, minY: 300, maxX: 600, maxY: 460 };
    const out = revealRectTransform({
      transform,
      rect,
      ...VIEWPORT,
      margin: MARGIN,
    });
    expect(out).toEqual(transform);
  });

  it('scrolls a far-right rect to sit inside the right margin, keeping zoom', () => {
    const transform = { x: 0, y: 0, zoom: 1 };
    const rect = { minX: 2000, minY: 380, maxX: 2200, maxY: 540 };
    const out = revealRectTransform({
      transform,
      rect,
      ...VIEWPORT,
      margin: MARGIN,
    });
    expect(out.zoom).toBe(1);
    const s = screenRect(rect, out);
    // Right edge pinned to the margin; the whole rect is now on-screen.
    expect(s.right).toBeCloseTo(VIEWPORT.viewportWidth - MARGIN);
    expect(s.left).toBeGreaterThanOrEqual(MARGIN - 0.001);
  });

  it('scrolls an above-viewport rect down to the top margin', () => {
    const transform = { x: 0, y: 0, zoom: 1 };
    const rect = { minX: 380, minY: -700, maxX: 580, maxY: -540 };
    const out = revealRectTransform({
      transform,
      rect,
      ...VIEWPORT,
      margin: MARGIN,
    });
    const s = screenRect(rect, out);
    expect(s.top).toBeCloseTo(MARGIN);
  });

  it('makes the minimum move (rect ends flush at the margin it crossed)', () => {
    const transform = { x: 0, y: 0, zoom: 1 };
    // Pokes ~148px past the right edge.
    const rect = { minX: 900, minY: 300, maxX: 1100, maxY: 460 };
    const out = revealRectTransform({
      transform,
      rect,
      ...VIEWPORT,
      margin: MARGIN,
    });
    expect(out.x).toBeCloseTo(-148);
    expect(out.y).toBe(0); // already in range vertically — untouched
  });

  it('preserves a non-1 zoom while revealing', () => {
    const transform = { x: 0, y: 0, zoom: 2 };
    const rect = { minX: 2000, minY: 100, maxX: 2100, maxY: 180 };
    const out = revealRectTransform({
      transform,
      rect,
      ...VIEWPORT,
      margin: MARGIN,
    });
    expect(out.zoom).toBe(2);
    const s = screenRect(rect, out);
    expect(s.right).toBeLessThanOrEqual(
      VIEWPORT.viewportWidth - MARGIN + 0.001,
    );
    expect(s.left).toBeGreaterThanOrEqual(MARGIN - 0.001);
  });

  it('aligns the leading edge to the margin when the rect is too big to fit', () => {
    // A clustered group can span more than the viewport; show the near portion
    // (leading edge at the margin) rather than failing to move.
    const transform = { x: 0, y: 0, zoom: 1 };
    const rect = { minX: 2000, minY: 300, maxX: 3000, maxY: 460 }; // 1000px wide
    const out = revealRectTransform({
      transform,
      rect,
      ...VIEWPORT,
      margin: MARGIN,
    });
    const s = screenRect(rect, out);
    expect(s.left).toBeCloseTo(MARGIN);
  });

  it('shows the NEAR edge for an oversized rect off the left (not the far edge)', () => {
    // Off entirely to the left and wider than the viewport: the user wants the
    // nearest (right) edge brought in, not a scroll to the far left edge.
    const transform = { x: 0, y: 0, zoom: 1 };
    const rect = { minX: -3000, minY: 300, maxX: -1800, maxY: 460 }; // 1200px wide
    const out = revealRectTransform({
      transform,
      rect,
      ...VIEWPORT,
      margin: MARGIN,
    });
    const s = screenRect(rect, out);
    // Right (near) edge pinned to the right margin; far edge stays off-left.
    expect(s.right).toBeCloseTo(VIEWPORT.viewportWidth - MARGIN);
    expect(s.left).toBeLessThan(MARGIN);
  });

  it('does not move an oversized rect that already spans the viewport', () => {
    // Bigger than the viewport but already covering it edge-to-edge: the
    // minimum move is zero, not a sideways jolt.
    const transform = { x: 0, y: 0, zoom: 1 };
    const rect = { minX: -100, minY: -100, maxX: 1100, maxY: 900 };
    const out = revealRectTransform({
      transform,
      rect,
      ...VIEWPORT,
      margin: MARGIN,
    });
    expect(out).toEqual(transform);
  });
});
