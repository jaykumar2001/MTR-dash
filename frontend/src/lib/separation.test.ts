import { describe, expect, it } from 'vitest';
import { anyOverlap, boxesOverlap, separateBoxes } from './separation.js';

describe('boxesOverlap / anyOverlap', () => {
  it('detects overlapping boxes', () => {
    const a = { id: 'a', x: 0, y: 0, width: 100, height: 50 };
    const b = { id: 'b', x: 50, y: 0, width: 100, height: 50 };
    expect(boxesOverlap(a, b)).toBe(true);
  });

  it('detects non-overlapping boxes', () => {
    const a = { id: 'a', x: 0, y: 0, width: 100, height: 50 };
    const b = { id: 'b', x: 200, y: 0, width: 100, height: 50 };
    expect(boxesOverlap(a, b)).toBe(false);
  });

  it('anyOverlap is false for a fully separated set', () => {
    const boxes = [
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 200, y: 0, width: 100, height: 50 },
      { id: 'c', x: 400, y: 0, width: 100, height: 50 },
    ];
    expect(anyOverlap(boxes)).toBe(false);
  });
});

describe('separateBoxes', () => {
  it('returns an empty map when nothing overlaps (idempotent no-op)', () => {
    const boxes = [
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 200, y: 0, width: 100, height: 50 },
    ];
    const disp = separateBoxes(boxes);
    expect(disp.size).toBe(0);
  });

  it('separates two identically-positioned boxes without an anchor (split evenly)', () => {
    const boxes = [
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 0, y: 0, width: 100, height: 50 },
    ];
    const disp = separateBoxes(boxes, { margin: 10 });
    expect(disp.size).toBe(2);
    const a = disp.get('a')!;
    const b = disp.get('b')!;
    // Resulting boxes must not overlap.
    const resolved = boxes.map((box) => {
      const d = disp.get(box.id);
      return d ? { ...box, x: box.x + d.dx, y: box.y + d.dy } : box;
    });
    expect(anyOverlap(resolved, 10)).toBe(false);
    // Symmetric split: displacement magnitudes should be equal and opposite.
    expect(a.dx).toBeCloseTo(-b.dx);
    expect(a.dy).toBeCloseTo(-b.dy);
  });

  it('never moves the anchored box; the other box absorbs the full push', () => {
    const boxes = [
      { id: 'anchor', x: 0, y: 0, width: 100, height: 50 },
      { id: 'mover', x: 10, y: 0, width: 100, height: 50 },
    ];
    const disp = separateBoxes(boxes, { margin: 5, anchorId: 'anchor' });
    expect(disp.has('anchor')).toBe(false);
    expect(disp.has('mover')).toBe(true);
  });

  it('resolves a chain of three overlapping boxes with no residual overlap', () => {
    const boxes = [
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 20, y: 0, width: 100, height: 50 },
      { id: 'c', x: 40, y: 0, width: 100, height: 50 },
    ];
    const disp = separateBoxes(boxes, { margin: 8 });
    const resolved = boxes.map((box) => {
      const d = disp.get(box.id);
      return d ? { ...box, x: box.x + d.dx, y: box.y + d.dy } : box;
    });
    expect(anyOverlap(resolved, 8)).toBe(false);
  });
});
