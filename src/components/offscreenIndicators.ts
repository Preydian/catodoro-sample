import type { CanvasTransform } from './useCanvas';
import type { StickyNote } from './StickyNote';

// Pure geometry for the off-screen note indicators ("edge arrows"). Kept
// separate from the component so the ray-to-edge math and clustering can be
// unit-tested without a DOM. Screen space here == viewport space, because the
// notes layer is position:fixed inset:0 (top-left origin).

type Viewport = { width: number; height: number };

type NoteIndicator = {
  id: string;
  noteType: 'text' | 'list';
  color: string;
  // Chip center in screen px, clamped to the inset viewport edge.
  x: number;
  y: number;
  // Radians from viewport center toward the note — the arrow's heading.
  angle: number;
};

type IndicatorCluster = {
  x: number;
  y: number;
  angle: number;
  members: NoteIndicator[];
};

// A note's screen rect is fully outside the viewport (so the user can't see any
// part of it and needs an arrow). Partially-visible notes return false.
const isNoteOffscreen = ({
  note,
  transform,
  viewport,
}: {
  note: StickyNote;
  transform: CanvasTransform;
  viewport: Viewport;
}): boolean => {
  const { zoom } = transform;
  // Match StickyNotesLayer, which paints the layer at an integer translate
  // (Math.round) to avoid sub-pixel blur. Detecting against the raw translate
  // would disagree by up to ~1px at the boundary, flickering a chip on/off for
  // a note whose painted edge is actually a sliver still on-screen.
  const tx = Math.round(transform.x);
  const ty = Math.round(transform.y);
  const left = note.x * zoom + tx;
  const top = note.y * zoom + ty;
  const right = (note.x + note.width) * zoom + tx;
  const bottom = (note.y + note.height) * zoom + ty;
  return (
    right <= 0 ||
    left >= viewport.width ||
    bottom <= 0 ||
    top >= viewport.height
  );
};

// Where the ray from the viewport center toward (sx, sy) crosses the viewport
// rectangle inset by `inset` px, plus that ray's heading. The center is always
// inside the inset rect and an off-screen note is always outside, so the ray
// exits exactly once.
const placeOnEdge = ({
  sx,
  sy,
  viewport,
  inset,
}: {
  sx: number;
  sy: number;
  viewport: Viewport;
  inset: number;
}) => {
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const dx = sx - cx;
  const dy = sy - cy;
  // Degenerate: the target projects exactly onto the center. No direction to
  // point, so pin to center with a neutral heading rather than emitting the
  // 0*Infinity = NaN coordinates the scale math below would otherwise produce.
  if (dx === 0 && dy === 0) return { x: cx, y: cy, angle: 0 };
  const angle = Math.atan2(dy, dx);
  const halfW = Math.max(1, cx - inset);
  const halfH = Math.max(1, cy - inset);
  const scaleX = dx === 0 ? Infinity : halfW / Math.abs(dx);
  const scaleY = dy === 0 ? Infinity : halfH / Math.abs(dy);
  const scale = Math.min(scaleX, scaleY);
  return { x: cx + dx * scale, y: cy + dy * scale, angle };
};

// One indicator per off-screen note, pinned to the viewport edge in the note's
// direction.
const computeNoteIndicators = ({
  notes,
  transform,
  viewport,
  inset,
}: {
  notes: StickyNote[];
  transform: CanvasTransform;
  viewport: Viewport;
  inset: number;
}): NoteIndicator[] => {
  const indicators: NoteIndicator[] = [];
  for (const note of notes) {
    if (!isNoteOffscreen({ note, transform, viewport })) continue;
    const centerX = note.x + note.width / 2;
    const centerY = note.y + note.height / 2;
    const sx = centerX * transform.zoom + transform.x;
    const sy = centerY * transform.zoom + transform.y;
    const { x, y, angle } = placeOnEdge({ sx, sy, viewport, inset });
    indicators.push({
      id: note.id,
      noteType: note.noteType,
      color: note.color,
      x,
      y,
      angle,
    });
  }
  return indicators;
};

// Merge indicators whose chips would land within `distance` px of each other
// into one cluster, so a pile of notes off the same edge reads as a single
// counted chip instead of an unreadable stack. Greedy first-fit over a stable
// position-sorted order, so grouping depends on on-screen geometry rather than
// the notes-array order. Each cluster keeps running sums so its centroid and
// circular-mean heading update in O(1) per add rather than re-scanning members.
const clusterIndicators = (
  indicators: NoteIndicator[],
  distance: number,
): IndicatorCluster[] => {
  const ordered = [...indicators].sort((a, b) => a.y - b.y || a.x - b.x);
  const clusters: IndicatorCluster[] = [];
  const sums: { x: number; y: number; sin: number; cos: number }[] = [];
  for (const ind of ordered) {
    const i = clusters.findIndex(
      (c) => Math.hypot(c.x - ind.x, c.y - ind.y) <= distance,
    );
    if (i === -1) {
      clusters.push({ x: ind.x, y: ind.y, angle: ind.angle, members: [ind] });
      sums.push({
        x: ind.x,
        y: ind.y,
        sin: Math.sin(ind.angle),
        cos: Math.cos(ind.angle),
      });
      continue;
    }
    const cluster = clusters[i];
    const s = sums[i];
    cluster.members.push(ind);
    s.x += ind.x;
    s.y += ind.y;
    s.sin += Math.sin(ind.angle);
    s.cos += Math.cos(ind.angle);
    const n = cluster.members.length;
    cluster.x = s.x / n;
    cluster.y = s.y / n;
    // Average headings as unit vectors to avoid the -π/π wraparound seam.
    cluster.angle = Math.atan2(s.sin, s.cos);
  }
  return clusters;
};

export { isNoteOffscreen, computeNoteIndicators, clusterIndicators };
export type { NoteIndicator, IndicatorCluster };
