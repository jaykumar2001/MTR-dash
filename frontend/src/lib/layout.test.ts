import { describe, expect, it } from 'vitest';
import { computeAutoLayout, type LayoutHopNode } from './layout.js';

describe('computeAutoLayout', () => {
  it('places hops at strictly increasing x in ttl order when there is no latency data', () => {
    const nodes: LayoutHopNode[] = [
      { id: '1', ttl: 1, active: true },
      { id: '2', ttl: 2, active: true },
      { id: '3', ttl: 3, active: true },
    ];
    const positions = computeAutoLayout(nodes, new Map());
    const x1 = positions.get('1')!.x;
    const x2 = positions.get('2')!.x;
    const x3 = positions.get('3')!.x;
    expect(x1).toBeLessThan(x2);
    expect(x2).toBeLessThan(x3);
  });

  it('gives a hop with a larger incremental latency a strictly larger x gap than one with ~0ms incremental latency', () => {
    const nodes: LayoutHopNode[] = [
      { id: '1', ttl: 1, active: true },
      { id: '2', ttl: 2, active: true },
      { id: '3', ttl: 3, active: true },
    ];
    // ttl1->ttl2: 0ms incremental (both at 5ms cumulative avg).
    // ttl2->ttl3: 50ms incremental (5ms -> 55ms cumulative avg).
    const avgLatencyMsByTtl = new Map([
      [1, 5],
      [2, 5],
      [3, 55],
    ]);
    const positions = computeAutoLayout(nodes, avgLatencyMsByTtl);
    const gap12 = positions.get('2')!.x - positions.get('1')!.x;
    const gap23 = positions.get('3')!.x - positions.get('2')!.x;
    expect(gap23).toBeGreaterThan(gap12);
  });

  it('clamps an extreme latency delta to maxHopGap', () => {
    const nodes: LayoutHopNode[] = [
      { id: '1', ttl: 1, active: true },
      { id: '2', ttl: 2, active: true },
    ];
    const avgLatencyMsByTtl = new Map([
      [1, 0],
      [2, 100000],
    ]);
    const positions = computeAutoLayout(nodes, avgLatencyMsByTtl, { maxHopGap: 420 });
    const gap = positions.get('2')!.x - positions.get('1')!.x;
    expect(gap).toBe(420);
  });

  it('stacks two stale nodes at the same ttl under that ttl\'s active node, same x, different y', () => {
    const nodes: LayoutHopNode[] = [
      { id: 'active', ttl: 2, active: true },
      { id: 'stale-a', ttl: 2, active: false },
      { id: 'stale-b', ttl: 2, active: false },
    ];
    const positions = computeAutoLayout(nodes, new Map());
    const activePos = positions.get('active')!;
    const staleA = positions.get('stale-a')!;
    const staleB = positions.get('stale-b')!;
    expect(staleA.x).toBe(activePos.x);
    expect(staleB.x).toBe(activePos.x);
    expect(staleA.y).toBeGreaterThan(activePos.y);
    expect(staleB.y).toBeGreaterThan(activePos.y);
    expect(staleA.y).not.toBe(staleB.y);
  });

  it('gives every stack in the box a consistent gap equal to the node height, both above the first stale node and between later ones', () => {
    const nodes: LayoutHopNode[] = [
      { id: 'active', ttl: 2, active: true },
      { id: 'stale-a', ttl: 2, active: false },
      { id: 'stale-b', ttl: 2, active: false },
    ];
    const options = { nodeHeight: 64 };
    const positions = computeAutoLayout(nodes, new Map(), options);
    const activePos = positions.get('active')!;
    const staleA = positions.get('stale-a')!;
    const staleB = positions.get('stale-b')!;

    // Boxes are positioned by their top-left corner and are nodeHeight tall,
    // so the blank gap between two stacked boxes is:
    //   (next box's top) - (previous box's top) - nodeHeight
    const gapAboveFirstStale = staleA.y - activePos.y - options.nodeHeight;
    const gapBetweenStale = staleB.y - staleA.y - options.nodeHeight;
    expect(gapAboveFirstStale).toBe(options.nodeHeight);
    expect(gapBetweenStale).toBe(options.nodeHeight);
    expect(gapBetweenStale).toBe(gapAboveFirstStale);
  });

  it('places every active node on a single flat row (y = 0), never staggered', () => {
    const nodes: LayoutHopNode[] = [
      { id: '1', ttl: 1, active: true },
      { id: '2', ttl: 2, active: true },
      { id: '3', ttl: 3, active: true },
      { id: '4', ttl: 4, active: true },
    ];
    // A deliberately tiny baseHopGap/minHopGap would have triggered
    // staggering under the old algorithm — every active node still lands
    // at y = 0, a straight line.
    const options = { baseHopGap: 10, minHopGap: 10 };
    const positions = computeAutoLayout(nodes, new Map(), options);
    for (const id of ['1', '2', '3', '4']) {
      expect(positions.get(id)!.y).toBe(0);
    }
  });

  it('never lets the x gap between consecutive active hops drop below nodeWidth + nodeGap, so the flat row never overlaps', () => {
    const nodes: LayoutHopNode[] = [
      { id: '1', ttl: 1, active: true },
      { id: '2', ttl: 2, active: true },
      { id: '3', ttl: 3, active: true },
    ];
    // baseHopGap/minHopGap are both far smaller than nodeWidth + nodeGap;
    // the actual gap must still be clamped up to that floor.
    const options = { baseHopGap: 10, minHopGap: 10, nodeWidth: 170, nodeGap: 20 };
    const positions = computeAutoLayout(nodes, new Map(), options);
    const gap12 = positions.get('2')!.x - positions.get('1')!.x;
    const gap23 = positions.get('3')!.x - positions.get('2')!.x;
    expect(gap12).toBeGreaterThanOrEqual(190);
    expect(gap23).toBeGreaterThanOrEqual(190);
  });

  it('gives a stale node a sensible position when its ttl has no active node at all', () => {
    const nodes: LayoutHopNode[] = [
      { id: '1', ttl: 1, active: true },
      { id: 'stale', ttl: 2, active: false },
    ];
    const positions = computeAutoLayout(nodes, new Map());
    const stalePos = positions.get('stale')!;
    expect(stalePos.x).toBeGreaterThan(positions.get('1')!.x);
    expect(stalePos.y).toBeGreaterThan(0);
  });

  it('falls back to 0 incremental latency on both sides of a missing middle ttl, instead of attributing the whole jump to one edge', () => {
    const nodes: LayoutHopNode[] = [
      { id: '1', ttl: 1, active: true },
      { id: '2', ttl: 2, active: true },
      { id: '3', ttl: 3, active: true },
    ];
    // ttl2 has no latency sample at all (e.g. no live edge with a `latest`
    // metric) — not present with a 0 value, just absent from the map.
    const avgLatencyMsByTtl = new Map([
      [1, 5],
      [3, 55],
    ]);
    // nodeWidth/nodeGap zeroed out so the overlap-avoidance floor (see the
    // "never lets the x gap... drop below nodeWidth + nodeGap" test) doesn't
    // mask the specific behavior under test here: the missing-data fallback.
    const options = { baseHopGap: 140, minHopGap: 90, maxHopGap: 420, nodeWidth: 0, nodeGap: 0 };
    const positions = computeAutoLayout(nodes, avgLatencyMsByTtl, options);
    const gap12 = positions.get('2')!.x - positions.get('1')!.x;
    const gap23 = positions.get('3')!.x - positions.get('2')!.x;
    expect(gap12).toBe(140);
    expect(gap23).toBe(140);
  });

  it('returns an empty map for an empty node list', () => {
    expect(computeAutoLayout([], new Map()).size).toBe(0);
  });
});
