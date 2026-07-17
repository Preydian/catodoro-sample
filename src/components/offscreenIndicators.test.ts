import { describe, it, expect } from 'vitest';
import {
  isNoteOffscreen,
  computeNoteIndicators,
  clusterIndicators,
} from './offscreenIndicators';
import type { NoteIndicator } from './offscreenIndicators';
import type { StickyNote } from './StickyNote';

const makeNote = (over: {
  id?: string;
  x: number;
  y: number;
  width?: number;
  height?: number;
}): StickyNote => ({
  id: over.id ?? 'n',
  color: 'lime',
  createdAt: '2024-01-01',
  width: 200,
  height: 160,
  noteType: 'text',
  text: '',
  title: null,
  ...over,
});

const IDENTITY = { x: 0, y: 0, zoom: 1 };
const VIEWPORT = { width: 1000, height: 800 };

describe('isNoteOffscreen', () => {
  it('is false for a note fully within the viewport', () => {
    const note = makeNote({ x: 400, y: 300 });
    expect(
      isNoteOffscreen({ note, transform: IDENTITY, viewport: VIEWPORT }),
    ).toBe(false);
  });

  it('is false for a note straddling an edge (partially visible)', () => {
    const note = makeNote({ x: -100, y: 300 }); // spans x -100..100
    expect(
      isNoteOffscreen({ note, transform: IDENTITY, viewport: VIEWPORT }),
    ).toBe(false);
  });

  it('is true for a note entirely past the right edge', () => {
    const note = makeNote({ x: 2000, y: 300 });
    expect(
      isNoteOffscreen({ note, transform: IDENTITY, viewport: VIEWPORT }),
    ).toBe(true);
  });

  it('accounts for the transform: a panned-away note becomes off-screen', () => {
    const note = makeNote({ x: 400, y: 300 });
    // Pan the world far left so the note's screen rect leaves the viewport.
    const panned = { x: -2000, y: 0, zoom: 1 };
    expect(
      isNoteOffscreen({ note, transform: panned, viewport: VIEWPORT }),
    ).toBe(true);
  });
});

describe('computeNoteIndicators', () => {
  const inset = 34;

  it('omits on-screen notes', () => {
    const notes = [makeNote({ x: 400, y: 300 })];
    expect(
      computeNoteIndicators({
        notes,
        transform: IDENTITY,
        viewport: VIEWPORT,
        inset,
      }),
    ).toEqual([]);
  });

  it('pins a far-right note to the right inset edge, pointing right', () => {
    const notes = [makeNote({ x: 2000, y: 380 })];
    const [ind] = computeNoteIndicators({
      notes,
      transform: IDENTITY,
      viewport: VIEWPORT,
      inset,
    });
    expect(ind.x).toBeCloseTo(VIEWPORT.width - inset); // 966
    expect(ind.y).toBeGreaterThan(380);
    expect(ind.y).toBeLessThan(440);
    expect(Math.abs(ind.angle)).toBeLessThan(0.2); // ~0 rad = rightward
  });

  it('pins a far-above note to the top inset edge, pointing up', () => {
    const notes = [makeNote({ x: 380, y: -700 })];
    const [ind] = computeNoteIndicators({
      notes,
      transform: IDENTITY,
      viewport: VIEWPORT,
      inset,
    });
    expect(ind.y).toBeCloseTo(inset); // 34
    expect(ind.angle).toBeCloseTo(-Math.PI / 2, 1); // straight up
  });

  it('carries id, color and type through for the reveal handler', () => {
    const notes = [
      makeNote({ id: 'a', x: 2000, y: 380, width: 200, height: 160 }),
    ];
    const [ind] = computeNoteIndicators({
      notes,
      transform: IDENTITY,
      viewport: VIEWPORT,
      inset,
    });
    expect(ind.id).toBe('a');
    expect(ind.noteType).toBe('text');
    expect(ind.color).toBe('lime');
  });
});

describe('clusterIndicators', () => {
  const ind = ({
    id,
    x,
    y,
  }: {
    id: string;
    x: number;
    y: number;
  }): NoteIndicator => ({
    id,
    noteType: 'text',
    color: 'lime',
    x,
    y,
    angle: 0,
  });

  it('keeps distant indicators as separate single-member clusters', () => {
    const out = clusterIndicators(
      [ind({ id: 'a', x: 50, y: 50 }), ind({ id: 'b', x: 900, y: 700 })],
      52,
    );
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.members.length === 1)).toBe(true);
  });

  it('merges indicators within the distance threshold', () => {
    const out = clusterIndicators(
      [
        ind({ id: 'a', x: 100, y: 100 }),
        ind({ id: 'b', x: 120, y: 110 }),
        ind({ id: 'c', x: 130, y: 90 }),
      ],
      52,
    );
    expect(out).toHaveLength(1);
    expect(out[0].members.map((m) => m.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('positions a cluster at the centroid of its members', () => {
    // 40px apart — within the 52px threshold, so they merge.
    const out = clusterIndicators(
      [ind({ id: 'a', x: 100, y: 200 }), ind({ id: 'b', x: 140, y: 200 })],
      52,
    );
    expect(out).toHaveLength(1);
    expect(out[0].x).toBeCloseTo(120);
    expect(out[0].y).toBeCloseTo(200);
  });

  it('groups by geometry regardless of input order', () => {
    const a = ind({ id: 'a', x: 100, y: 0 });
    const b = ind({ id: 'b', x: 100, y: 40 });
    const c = ind({ id: 'c', x: 100, y: 80 });
    // a<->c are 80px apart (> 52), so the grouping hinges on visiting order;
    // a position-sorted pass makes it deterministic either way in.
    const forward = clusterIndicators([a, b, c], 52).map((cl) =>
      cl.members.map((m) => m.id).sort(),
    );
    const reversed = clusterIndicators([c, b, a], 52).map((cl) =>
      cl.members.map((m) => m.id).sort(),
    );
    expect(forward).toEqual(reversed);
  });
});
