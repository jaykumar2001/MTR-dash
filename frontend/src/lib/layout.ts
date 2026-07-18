// Pure default-layout computation for the network map. No React/React Flow
// dependency by design — this is a plain function over node TTL/active-state
// and a latency-per-TTL map, independently testable and independently
// reasoned about. NetworkMap.tsx is the only caller; it merges this output
// with any user-saved (dragged) positions before handing everything to the
// existing resolveOverlaps collision pass (lib/separation.ts), which is
// unchanged and remains the final safety net.
//
// See docs/superpowers/specs/2026-07-10-map-auto-layout-design.md for the
// full rationale behind each constant and the stacking rule. Two earlier
// versions of this staggered the active row vertically (first alternating,
// then a one-directional "waterfall" cascade) to let hop distance shrink
// below a full node footprint without overlapping — both were reported as
// confusing to read. This version drops staggering entirely: every active
// hop sits on a single straight row, and the x-gap floor is raised to
// guarantee that row never needs a vertical nudge to avoid overlapping.

export interface LayoutHopNode {
  id: string;
  ttl: number;
  active: boolean;
}

export interface LayoutOptions {
  nodeWidth?: number;
  nodeHeight?: number;
  nodeGap?: number;
  baseHopGap?: number;
  minHopGap?: number;
  maxHopGap?: number;
  latencyScalePxPerMs?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  nodeWidth: 170,
  nodeHeight: 64,
  nodeGap: 20,
  baseHopGap: 140,
  minHopGap: 90,
  maxHopGap: 420,
  latencyScalePxPerMs: 4,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function computeAutoLayout(
  nodes: LayoutHopNode[],
  avgLatencyMsByTtl: Map<number, number>,
  options: LayoutOptions = {},
): Map<string, { x: number; y: number }> {
  const opts = { ...DEFAULTS, ...options };
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  const maxTtl = nodes.reduce((max, n) => Math.max(max, n.ttl), 0);

  // Step 1: x per ttl column, driven by incremental latency between
  // consecutive ttls. Each comparison looks up the two raw ttl entries
  // fresh — missing data on either side falls back to 0 incremental
  // latency, never to a neighboring (possibly also-fallback) value.
  // Carrying a smoothed value forward would misattribute a later real jump
  // to a single edge when an intermediate ttl was actually missing; see
  // docs/superpowers/specs/2026-07-10-map-auto-layout-design.md.
  //
  // The gap is always clamped to at least nodeWidth + nodeGap, on top of
  // minHopGap — this is what lets the whole active row sit on one straight
  // line (Step 2) without ever needing a vertical nudge to avoid
  // overlapping.
  const gapFloor = Math.max(opts.minHopGap, opts.nodeWidth + opts.nodeGap);
  const ttlX = new Map<number, number>();
  let x = 0;
  for (let ttl = 1; ttl <= maxTtl; ttl++) {
    if (ttl > 1) {
      const prevRaw = avgLatencyMsByTtl.get(ttl - 1);
      const currRaw = avgLatencyMsByTtl.get(ttl);
      const incremental =
        prevRaw === undefined || currRaw === undefined ? 0 : Math.max(0, currRaw - prevRaw);
      const gap = clamp(
        opts.baseHopGap + incremental * opts.latencyScalePxPerMs,
        gapFloor,
        opts.maxHopGap,
      );
      x += gap;
    }
    ttlX.set(ttl, x);
  }

  // Step 2: active row — every active hop sits at y = 0, a single straight
  // line. Step 1's gap floor already guarantees no two adjacent active
  // hops can overlap, so there's nothing else to resolve here.
  const activeByTtl = new Map<number, LayoutHopNode>();
  const staleByTtl = new Map<number, LayoutHopNode[]>();
  for (const n of nodes) {
    if (n.active) {
      activeByTtl.set(n.ttl, n);
    } else {
      const list = staleByTtl.get(n.ttl) ?? [];
      list.push(n);
      staleByTtl.set(n.ttl, list);
    }
  }
  for (const [ttl, node] of activeByTtl) {
    positions.set(node.id, { x: ttlX.get(ttl) ?? 0, y: 0 });
  }

  // Step 3: stale/synthetic nodes stack under their ttl's active node (or
  // the ttl's computed column if nothing is active there), same x, with a
  // single consistent blank gap — equal to the node's own height — between
  // every box in the stack: active-to-first-stale and stale-to-stale alike.
  // Boxes are positioned by their top-left corner, so each "slot" (box +
  // trailing gap) is 2 * nodeHeight tall, and the active row's own box
  // (always y = 0, see Step 2) occupies the first slot implicitly.
  for (const [ttl, staleNodes] of staleByTtl) {
    const nodeX = ttlX.get(ttl) ?? 0;
    const sorted = staleNodes.slice().sort((a, b) => a.id.localeCompare(b.id));
    sorted.forEach((n, i) => {
      const y = (i + 1) * (opts.nodeHeight * 2);
      positions.set(n.id, { x: nodeX, y });
    });
  }

  return positions;
}
