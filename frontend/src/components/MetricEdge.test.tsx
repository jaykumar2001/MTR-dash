import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Position, ReactFlowProvider } from '@xyflow/react';
import { MetricEdge } from './MetricEdge.js';

const baseProps = {
  id: 'e1',
  source: '0',
  target: '1',
  sourceX: 0,
  sourceY: 0,
  targetX: 100,
  targetY: 0,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
  data: {
    color: 'yellow' as const,
    active: true,
    stale: false,
    dimmed: false,
    highlighted: false,
    latest: { lossPct: 2, snt: 10, last: 1, avg: 1.2, best: 1, wrst: 1.5, stdev: 0.1 },
  },
};

describe('MetricEdge', () => {
  it('renders a curved (bezier) path colored by the edge data', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).not.toBeNull();
    expect(path).toHaveStyle({ stroke: 'yellow' });
    // A straight two-point path is a single "M x y L x y" segment; a bezier
    // path uses a "C" (cubic) command even between two simple points.
    expect(path?.getAttribute('d')).toMatch(/C/);
  });

  it('dashes the path when the edge is inactive', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} data={{ ...baseProps.data, active: false }} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ strokeDasharray: '6 4' });
  });

  it('renders grey and dashed when the edge is a stale connector', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge
            {...baseProps}
            data={{ color: 'grey', active: true, stale: true, latest: undefined }}
          />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ stroke: 'grey', strokeDasharray: '6 4' });
  });

  it('renders a thicker stroke when selected', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} selected />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ strokeWidth: '4' });
  });

  it('reduces opacity when dimmed', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} data={{ ...baseProps.data, dimmed: true }} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ opacity: '0.15' });
  });

  it('renders full opacity when not dimmed', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} data={{ ...baseProps.data, dimmed: false }} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ opacity: '1' });
  });

  it('increases stroke width and adds an accent glow when highlighted', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} data={{ ...baseProps.data, dimmed: false, highlighted: true }} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ strokeWidth: '5' });
    expect(path?.getAttribute('style')).toMatch(/drop-shadow/);
  });

  it('keeps the loss-status stroke color unchanged when highlighted', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} data={{ ...baseProps.data, dimmed: false, highlighted: true }} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path).toHaveStyle({ stroke: 'yellow' });
  });

  it('applies no glow filter when not highlighted', () => {
    const { container } = render(
      <ReactFlowProvider>
        <svg>
          <MetricEdge {...baseProps} data={{ ...baseProps.data, dimmed: false, highlighted: false }} />
        </svg>
      </ReactFlowProvider>,
    );
    const path = container.querySelector('path.react-flow__edge-path');
    expect(path?.getAttribute('style')).not.toMatch(/drop-shadow/);
  });
});
