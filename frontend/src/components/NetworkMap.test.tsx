import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NetworkMap, isPersistableNodeId } from './NetworkMap.js';
import { api } from '../api/client.js';
import type { MapResult } from '../types.js';

vi.mock('../api/client.js', () => ({
  api: {
    setNodePosition: vi.fn(),
    getWhois: vi.fn(),
    getWhoisBulk: vi.fn().mockResolvedValue({}),
    getDnsBulk: vi.fn().mockResolvedValue({}),
    getGeoipBulk: vi.fn().mockResolvedValue({}),
  },
}));

// jsdom (frontend/test/setup.ts, Task 12) has no ResizeObserver polyfill, but a real
// <ReactFlow> mounts ZoomPane, which observes the container for resize/measurement.
// Polyfill locally (not in the shared setup) to keep the blast radius scoped to this test.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mapData: MapResult = {
  nodes: [{ id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 0, y: 0 }],
  edges: [
    {
      id: '0-1',
      source: 0,
      target: 1,
      color: 'green',
      stale: false,
      avgLossPct: 0,
      latest: { lossPct: 0, snt: 10, last: 1, avg: 1, best: 1, wrst: 1, stdev: 0 },
    },
  ],
};

describe('NetworkMap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a node per hop plus the synthetic source node', () => {
    render(<NetworkMap targetId={1} mapData={mapData} />);
    expect(screen.getByText('192.168.1.1')).toBeInTheDocument();
    expect(screen.getByText('this host')).toBeInTheDocument();
  });

  it('shows a resolved hostname on a hop node once the DNS bulk lookup resolves', async () => {
    vi.mocked(api.getDnsBulk).mockResolvedValueOnce({ '192.168.1.1': 'router.example.com' });
    render(<NetworkMap targetId={1} mapData={mapData} />);

    expect(await screen.findByText('router.example.com')).toBeInTheDocument();
    expect(api.getDnsBulk).toHaveBeenCalledWith(['192.168.1.1']);
  });

  it('renders the legend', () => {
    render(<NetworkMap targetId={1} mapData={mapData} />);
    expect(screen.getByText(/0% loss/)).toBeInTheDocument();
  });

  it('resyncs rendered nodes when the mapData prop changes after a re-render', () => {
    const { rerender } = render(<NetworkMap targetId={1} mapData={mapData} />);
    expect(screen.getByText('192.168.1.1')).toBeInTheDocument();

    const updatedMapData: MapResult = {
      ...mapData,
      nodes: [{ id: 1, ttl: 1, host: '10.0.0.99', active: true, x: 0, y: 0 }],
    };
    rerender(<NetworkMap targetId={1} mapData={updatedMapData} />);

    expect(screen.getByText('10.0.0.99')).toBeInTheDocument();
    expect(screen.queryByText('192.168.1.1')).not.toBeInTheDocument();
  });

  it('renders a live-active node as inactive when historyActive has a different host at that ttl', () => {
    render(
      <NetworkMap
        targetId={1}
        mapData={mapData}
        historyActive={[{ ttl: 1, host: 'some-other-host' }]}
      />,
    );
    const hostEl = screen.getByText('192.168.1.1');
    expect(hostEl.closest('.hop-node')).toHaveClass('inactive');
    expect(hostEl.closest('.hop-node')).not.toHaveClass('active');
  });

  it('renders a live-inactive node as active when historyActive matches its ttl and host', () => {
    const inactiveMapData: MapResult = {
      ...mapData,
      nodes: [{ id: 1, ttl: 1, host: '192.168.1.1', active: false, x: 0, y: 0 }],
    };
    render(
      <NetworkMap
        targetId={1}
        mapData={inactiveMapData}
        historyActive={[{ ttl: 1, host: '192.168.1.1' }]}
      />,
    );
    const hostEl = screen.getByText('192.168.1.1');
    expect(hostEl.closest('.hop-node')).toHaveClass('active');
    expect(hostEl.closest('.hop-node')).not.toHaveClass('inactive');
  });

  it('matches historyActive against a node\'s rawHost, not its (possibly relabeled) display host', () => {
    // A relabeled node (e.g. via backend known-bridge inference) shows a
    // display host that differs from what was actually recorded in its poll
    // history — historyActive entries are built from that raw history, so
    // matching must use rawHost, or a genuinely-active historical moment
    // would render as inactive.
    const relabeledMapData: MapResult = {
      ...mapData,
      nodes: [
        { id: 1, ttl: 1, host: 'inferred-host', rawHost: '???', active: false, x: 0, y: 0 },
      ],
    };
    render(
      <NetworkMap
        targetId={1}
        mapData={relabeledMapData}
        historyActive={[{ ttl: 1, host: '???' }]}
      />,
    );
    const hostEl = screen.getByText('inferred-host');
    expect(hostEl.closest('.hop-node')).toHaveClass('active');
    expect(hostEl.closest('.hop-node')).not.toHaveClass('inactive');
  });

  it('shows a metrics table at the click position when a link is clicked, and hides it on pane click', () => {
    const { container } = render(<NetworkMap targetId={1} mapData={mapData} />);

    const edgePath = container.querySelector('path.react-flow__edge-path');
    expect(edgePath).not.toBeNull();
    fireEvent.click(edgePath!, { clientX: 300, clientY: 150 });

    const table = container.querySelector('.edge-metrics-table') as HTMLElement;
    expect(table).not.toBeNull();
    expect(table.style.left).toBe('312px');
    expect(table.style.top).toBe('162px');
    expect(screen.getByText('Loss')).toBeInTheDocument();

    const pane = container.querySelector('.react-flow__pane');
    fireEvent.click(pane!);
    expect(container.querySelector('.edge-metrics-table')).toBeNull();
  });

  it('renders a dashed grey edge for a stale connector', () => {
    const staleMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 0, y: 0 },
        { id: 2, ttl: 1, host: 'old-hop', active: false, x: 0, y: 140 },
      ],
      edges: [
        mapData.edges[0],
        { id: '0-2', source: 0, target: 2, color: 'grey', stale: true },
      ],
    };
    const { container } = render(<NetworkMap targetId={1} mapData={staleMapData} />);
    const paths = container.querySelectorAll('path.react-flow__edge-path');
    expect(paths).toHaveLength(2);
    expect(paths[1]).toHaveStyle({ stroke: 'grey', strokeDasharray: '6 4' });
  });

  it('does not open the metrics popup when a stale edge is clicked', () => {
    const staleMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 0, y: 0 },
        { id: 2, ttl: 1, host: 'old-hop', active: false, x: 0, y: 140 },
      ],
      edges: [{ id: '0-2', source: 0, target: 2, color: 'grey', stale: true }],
    };
    const { container } = render(<NetworkMap targetId={1} mapData={staleMapData} />);
    const edgePath = container.querySelector('path.react-flow__edge-path');
    fireEvent.click(edgePath!, { clientX: 300, clientY: 150 });
    expect(container.querySelector('.edge-metrics-table')).toBeNull();
  });

  it('keeps stale connector edges visible while viewing a historical snapshot', () => {
    const staleMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 0, y: 0 },
        { id: 2, ttl: 1, host: 'old-hop', active: false, x: 0, y: 140 },
      ],
      edges: [
        mapData.edges[0],
        { id: '0-2', source: 0, target: 2, color: 'grey', stale: true },
      ],
    };
    const { container } = render(
      <NetworkMap
        targetId={1}
        mapData={staleMapData}
        historyActive={[{ ttl: 1, host: '192.168.1.1' }]}
      />,
    );
    const paths = container.querySelectorAll('path.react-flow__edge-path');
    expect(paths).toHaveLength(2);
    expect(paths[1]).toHaveStyle({ stroke: 'grey', strokeDasharray: '6 4' });
  });

  it('renders an inferred node with a distinct marker and tooltip, and a non-inferred node without either', () => {
    const inferredMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 0, y: 0 },
        {
          id: 'inferred:2:10.0.0.5',
          ttl: 2,
          host: '10.0.0.5',
          active: false,
          x: 220,
          y: 140,
          inferred: true,
        },
      ],
      edges: [],
    };
    render(<NetworkMap targetId={1} mapData={inferredMapData} />);

    const inferredEl = screen.getByText('10.0.0.5').closest('.hop-node') as HTMLElement;
    expect(inferredEl).toHaveClass('inferred');
    expect(inferredEl.title).not.toBe('');

    const normalEl = screen.getByText('192.168.1.1').closest('.hop-node') as HTMLElement;
    expect(normalEl).not.toHaveClass('inferred');
    expect(normalEl.title).toBe('');
  });

  it('never renders two nodes at the same position, even if the backend gives them identical coordinates', () => {
    const overlappingMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: 'hop-a', active: true, x: 0, y: 0 },
        { id: 2, ttl: 2, host: 'hop-b', active: true, x: 0, y: 0 },
      ],
      edges: [],
    };
    const { container } = render(<NetworkMap targetId={1} mapData={overlappingMapData} />);

    const nodeEls = Array.from(container.querySelectorAll('.react-flow__node')) as HTMLElement[];
    const transforms = nodeEls.map((el) => el.style.transform);
    expect(new Set(transforms).size).toBe(transforms.length);
  });

  it('shows a whois popup with fetched fields when a hop node is clicked', async () => {
    vi.mocked(api.getWhois).mockResolvedValue({
      host: '192.168.1.1',
      fields: [{ key: 'NetName', value: 'TEST-NET' }],
    });
    const { container } = render(<NetworkMap targetId={1} mapData={mapData} />);

    const nodeEl = screen.getByText('192.168.1.1').closest('.react-flow__node') as HTMLElement;
    fireEvent.click(nodeEl, { clientX: 200, clientY: 100 });

    expect(api.getWhois).toHaveBeenCalledWith('192.168.1.1');
    expect(container.querySelector('.node-whois-table')).not.toBeNull();
    await waitFor(() => expect(screen.getByText('NetName')).toBeInTheDocument());
    expect(screen.getByText('TEST-NET')).toBeInTheDocument();
  });

  it('shows a copy affordance for IP-looking whois values but not for plain text values', async () => {
    vi.mocked(api.getWhois).mockResolvedValue({
      host: '192.168.1.1',
      fields: [
        { key: 'NetRange', value: '192.168.1.0/24' },
        { key: 'OrgName', value: 'Example Org' },
      ],
    });
    render(<NetworkMap targetId={1} mapData={mapData} />);
    const nodeEl = screen.getByText('192.168.1.1').closest('.react-flow__node') as HTMLElement;
    fireEvent.click(nodeEl, { clientX: 200, clientY: 100 });

    await waitFor(() => expect(screen.getByText('192.168.1.0/24')).toBeInTheDocument());
    expect(screen.getByText('192.168.1.0/24')).toHaveClass('copyable');
    expect(screen.getByText('Example Org')).not.toHaveClass('copyable');
  });

  it('shows an error message when the whois lookup fails', async () => {
    vi.mocked(api.getWhois).mockRejectedValue(new Error('no whois server known'));
    render(<NetworkMap targetId={1} mapData={mapData} />);
    const nodeEl = screen.getByText('192.168.1.1').closest('.react-flow__node') as HTMLElement;
    fireEvent.click(nodeEl, { clientX: 200, clientY: 100 });

    expect(await screen.findByText(/no whois server known/)).toBeInTheDocument();
  });

  it('closes the whois popup when the same node is clicked again', async () => {
    vi.mocked(api.getWhois).mockResolvedValue({ host: '192.168.1.1', fields: [] });
    const { container } = render(<NetworkMap targetId={1} mapData={mapData} />);
    const nodeEl = screen.getByText('192.168.1.1').closest('.react-flow__node') as HTMLElement;

    fireEvent.click(nodeEl, { clientX: 200, clientY: 100 });
    await screen.findByText('No whois data available');

    fireEvent.click(nodeEl, { clientX: 200, clientY: 100 });
    expect(container.querySelector('.node-whois-table')).toBeNull();
  });

  it('does not trigger a whois lookup when clicking the synthetic source node', () => {
    const { container } = render(<NetworkMap targetId={1} mapData={mapData} />);
    const sourceNodeEl = screen.getByText('this host').closest('.react-flow__node') as HTMLElement;

    fireEvent.click(sourceNodeEl, { clientX: 50, clientY: 50 });

    expect(api.getWhois).not.toHaveBeenCalled();
    expect(container.querySelector('.node-whois-table')).toBeNull();
  });

  it('does not attempt a whois lookup for an unresolved (???) hop, showing "No whois data available" immediately', () => {
    const dataWithUnknownHop: MapResult = {
      nodes: [...mapData.nodes, { id: 2, ttl: 2, host: '???', active: true, x: 220, y: 0 }],
      edges: [
        ...mapData.edges,
        { id: '1-2', source: 1, target: 2, color: 'grey', stale: false },
      ],
    };
    const { container } = render(<NetworkMap targetId={1} mapData={dataWithUnknownHop} />);
    const nodeEl = screen.getByText('???').closest('.react-flow__node') as HTMLElement;

    fireEvent.click(nodeEl, { clientX: 200, clientY: 100 });

    expect(api.getWhois).not.toHaveBeenCalled();
    expect(container.querySelector('.node-whois-status.error')).toBeNull();
    expect(screen.getByText('No whois data available')).toBeInTheDocument();
  });

  it('lazily bulk-loads whois summaries for every hop host on mount, without any click', () => {
    render(<NetworkMap targetId={1} mapData={mapData} />);
    expect(api.getWhoisBulk).toHaveBeenCalledWith(['192.168.1.1']);
  });

  it('renders the netname once the whois bulk summary resolves', async () => {
    vi.mocked(api.getWhoisBulk).mockResolvedValue({
      '192.168.1.1': { netname: 'EXAMPLE-NET' },
    });
    render(<NetworkMap targetId={1} mapData={mapData} />);

    await screen.findByText('EXAMPLE-NET');
  });

  it('renders a country flag and city once the geoip bulk summary resolves', async () => {
    vi.mocked(api.getGeoipBulk).mockResolvedValue({
      '192.168.1.1': { country: 'US', city: 'Mountain View' },
    });
    const { container } = render(<NetworkMap targetId={1} mapData={mapData} />);

    await screen.findByText('Mountain View, US');
    expect(container.querySelector('.hop-node-flag')).not.toBeNull();
  });

  it('lazily bulk-loads geoip summaries for every hop host on mount, without any click', () => {
    render(<NetworkMap targetId={1} mapData={mapData} />);
    expect(api.getGeoipBulk).toHaveBeenCalledWith(['192.168.1.1']);
  });

  it('does not request the same host again when re-rendered with unchanged hosts', () => {
    const { rerender } = render(<NetworkMap targetId={1} mapData={mapData} />);
    expect(api.getWhoisBulk).toHaveBeenCalledTimes(1);

    rerender(<NetworkMap targetId={1} mapData={{ ...mapData }} />);
    expect(api.getWhoisBulk).toHaveBeenCalledTimes(1);
  });

  it('requests only the newly-seen host when a new hop is added', () => {
    const { rerender } = render(<NetworkMap targetId={1} mapData={mapData} />);
    expect(api.getWhoisBulk).toHaveBeenCalledWith(['192.168.1.1']);

    const withSecondHop: MapResult = {
      ...mapData,
      nodes: [...mapData.nodes, { id: 2, ttl: 2, host: '8.8.8.8', active: true, x: 220, y: 0 }],
    };
    rerender(<NetworkMap targetId={1} mapData={withSecondHop} />);

    expect(api.getWhoisBulk).toHaveBeenLastCalledWith(['8.8.8.8']);
  });

  it('renders a node with hasCustomPosition at exactly its given x/y, not an auto-computed one', () => {
    const customMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 150, y: 250, hasCustomPosition: true },
      ],
      edges: [],
    };
    render(<NetworkMap targetId={1} mapData={customMapData} />);
    const nodeEl = screen.getByText('192.168.1.1').closest('.react-flow__node') as HTMLElement;
    expect(nodeEl.style.transform).toBe('translate(150px,250px)');
  });

  it('renders a node without hasCustomPosition at an auto-computed position, not its raw backend x/y', () => {
    const autoMapData: MapResult = {
      nodes: [
        // x/y here mimic the backend's old idx*220 fallback deliberately, to
        // prove they're ignored once hasCustomPosition is false.
        { id: 1, ttl: 1, host: 'hop-a', active: true, x: 999, y: 999, hasCustomPosition: false },
      ],
      edges: [],
    };
    render(<NetworkMap targetId={1} mapData={autoMapData} />);
    const nodeEl = screen.getByText('hop-a').closest('.react-flow__node') as HTMLElement;
    expect(nodeEl.style.transform).not.toBe('translate(999px,999px)');
  });

  it('places a stale node directly under its active counterpart at the same ttl (auto layout)', () => {
    const staleUnderMapData: MapResult = {
      nodes: [
        { id: 1, ttl: 1, host: 'active-hop', active: true, x: 0, y: 0, hasCustomPosition: false },
        { id: 2, ttl: 1, host: 'stale-hop', active: false, x: 0, y: 0, hasCustomPosition: false },
      ],
      edges: [{ id: '0-1', source: 0, target: 1, color: 'green', stale: false }],
    };
    render(<NetworkMap targetId={1} mapData={staleUnderMapData} />);
    const activeEl = screen.getByText('active-hop').closest('.react-flow__node') as HTMLElement;
    const staleEl = screen.getByText('stale-hop').closest('.react-flow__node') as HTMLElement;

    const parseTranslate = (t: string) => {
      const m = /translate\(([-\d.]+)px,([-\d.]+)px\)/.exec(t);
      return { x: Number(m![1]), y: Number(m![2]) };
    };
    const activePos = parseTranslate(activeEl.style.transform);
    const stalePos = parseTranslate(staleEl.style.transform);

    expect(stalePos.x).toBe(activePos.x);
    expect(stalePos.y).toBeGreaterThan(activePos.y);
  });

  it('renders both active styling and the inferred marker on an active inferred node', () => {
    const inferredActiveMapData: MapResult = {
      ...mapData,
      nodes: [
        { id: 1, ttl: 1, host: '10.0.0.1', rawHost: '???', active: true, inferred: true, x: 0, y: 0 },
      ],
    };
    render(<NetworkMap targetId={1} mapData={inferredActiveMapData} />);
    const hostEl = screen.getByText('10.0.0.1');
    const nodeEl = hostEl.closest('.hop-node');
    expect(nodeEl).toHaveClass('active');
    expect(nodeEl).toHaveClass('inferred');
    expect(nodeEl).not.toHaveClass('inactive');
  });
});

describe('isPersistableNodeId', () => {
  it('is true for a real numeric node id', () => {
    expect(isPersistableNodeId('42')).toBe(true);
  });

  it('is false for the synthetic source node id', () => {
    expect(isPersistableNodeId('source')).toBe(false);
  });

  it('is false for a synthetic ??? gap node id', () => {
    expect(isPersistableNodeId('synthetic:3-3|B|run:5:3')).toBe(false);
  });
});
