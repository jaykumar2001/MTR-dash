import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { NetworkMap } from './NetworkMap.js';
import { saveViewport } from '../lib/viewport.js';
import type { MapResult } from '../types.js';

// This test lives in its own file, separate from NetworkMap.test.tsx: mocking
// @xyflow/react's useReactFlow (needed to spy on fitView) interferes with
// <ReactFlow>'s internal node click/selection wiring when both are exercised
// in the same test run, so node-click assertions must stay in an unmocked
// file. This file only asserts fitView/setViewport calls and never simulates
// a click.
const fitViewMock = vi.fn();
const setViewportMock = vi.fn();
vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    useReactFlow: () => ({
      ...actual.useReactFlow(),
      fitView: fitViewMock,
      setViewport: setViewportMock,
    }),
  };
});

vi.mock('../api/client.js', () => ({
  api: {
    setNodePosition: vi.fn(),
    getWhois: vi.fn(),
    getWhoisBulk: vi.fn().mockResolvedValue({}),
    getDnsBulk: vi.fn().mockResolvedValue({}),
  },
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

const mapData: MapResult = {
  nodes: [{ id: 1, ttl: 1, host: '192.168.1.1', active: true, x: 0, y: 0 }],
  edges: [],
};

describe('NetworkMap fit-to-screen', () => {
  beforeEach(() => {
    localStorage.clear();
    fitViewMock.mockClear();
    setViewportMock.mockClear();
  });

  it('fits the view to all nodes on initial render', () => {
    render(<NetworkMap targetId={1} mapData={mapData} />);
    expect(fitViewMock).toHaveBeenCalled();
  });

  it('fits the view again whenever the rendered node set changes', () => {
    const { rerender } = render(<NetworkMap targetId={1} mapData={mapData} />);
    fitViewMock.mockClear();

    const biggerMapData: MapResult = {
      ...mapData,
      nodes: [...mapData.nodes, { id: 2, ttl: 2, host: 'second-hop', active: true, x: 300, y: 0 }],
    };
    rerender(<NetworkMap targetId={1} mapData={biggerMapData} />);

    expect(fitViewMock).toHaveBeenCalled();
  });

  it('never auto-fits over a viewport the user chose for this target', () => {
    saveViewport(1, { x: 40, y: -20, zoom: 1.5 });

    const { rerender } = render(<NetworkMap targetId={1} mapData={mapData} />);
    const biggerMapData: MapResult = {
      ...mapData,
      nodes: [...mapData.nodes, { id: 2, ttl: 2, host: 'second-hop', active: true, x: 300, y: 0 }],
    };
    rerender(<NetworkMap targetId={1} mapData={biggerMapData} />);

    expect(fitViewMock).not.toHaveBeenCalled();
  });

  it('restores the saved viewport when switching to a target that has one', () => {
    const { rerender } = render(<NetworkMap targetId={1} mapData={mapData} />);
    setViewportMock.mockClear();
    fitViewMock.mockClear();

    saveViewport(2, { x: 10, y: 20, zoom: 0.8 });
    rerender(<NetworkMap targetId={2} mapData={mapData} />);

    expect(setViewportMock).toHaveBeenCalledWith({ x: 10, y: 20, zoom: 0.8 });
    expect(fitViewMock).not.toHaveBeenCalled();
  });
});
