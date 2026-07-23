import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react';
import type { EdgeMetrics } from '../types.js';

export interface MetricEdgeData extends Record<string, unknown> {
  color: 'green' | 'yellow' | 'red' | 'grey';
  latest?: EdgeMetrics;
  active: boolean;
  stale: boolean;
  dimmed: boolean;
  highlighted: boolean;
}

/**
 * Renders only the cable-run path. The metrics table shown on click is owned
 * by NetworkMap (a single cursor-anchored overlay), not this component — see
 * NetworkMap.tsx's onEdgeClick handler.
 */
export function MetricEdge({
  id,
  sourceX,
  sourceY,
  sourcePosition,
  targetX,
  targetY,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const edgeData = data as MetricEdgeData;

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      interactionWidth={20}
      style={{
        // stroke/color (the loss-status signal) are never affected by
        // `highlighted` — see this plan's Global Constraints.
        stroke: edgeData.color,
        // Lets the hover/selected glow (styles.css) pick up this edge's own
        // color via `currentColor`, so the halo always matches the link.
        color: edgeData.color,
        strokeWidth: edgeData.highlighted ? 5 : selected ? 4 : 3,
        strokeDasharray: edgeData.stale || !edgeData.active ? '6 4' : undefined,
        opacity: edgeData.dimmed ? 0.15 : 1,
        // Inline `filter` takes precedence over styles.css's `:hover`/
        // `.selected` currentColor glow rule for the specific edge under
        // the cursor — intentional: it ends up with the same prominent
        // accent glow as the rest of its highlighted route, not a dimmer
        // self-only one.
        filter: edgeData.highlighted
          ? 'drop-shadow(0 0 3px var(--accent-strong)) drop-shadow(0 0 8px var(--accent))'
          : undefined,
      }}
    />
  );
}
