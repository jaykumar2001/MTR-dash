import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { App } from './App.js';
import { api } from './api/client.js';
import type { Deviation, HistoryResult } from './types.js';

// jsdom (frontend/test/setup.ts, Task 12) has no ResizeObserver polyfill, but a real
// <ReactFlow> (rendered inside App via NetworkMap) mounts ZoomPane, which observes the
// container for resize/measurement. Polyfill locally (not in the shared setup) to keep
// the blast radius scoped to this test, matching the precedent set in NetworkMap.test.tsx.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

vi.mock('./api/client.js', () => ({
  api: {
    listTargets: vi.fn(),
    getMap: vi.fn(),
    getDeviations: vi.fn(),
    getRunHistory: vi.fn(),
    createTarget: vi.fn(),
    deleteTarget: vi.fn(),
    updateTarget: vi.fn(),
    getHistory: vi.fn(),
    setNodePosition: vi.fn(),
    getWhois: vi.fn(),
    getWhoisBulk: vi.fn().mockResolvedValue({}),
    getDnsBulk: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('./hooks/useSSE.js', () => ({ useSSE: vi.fn() }));

describe('App', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(api.listTargets).mockResolvedValue([
      {
        id: 1,
        host: '1.1.1.1',
        intervalSeconds: 60,
        reportCycles: 10,
        enabled: true,
        maxStaleHops: 1,
        addressFamily: 'auto',
        createdAt: '2026-07-06T00:00:00.000Z',
      },
    ]);
    vi.mocked(api.getMap).mockResolvedValue({ nodes: [], edges: [] });
    vi.mocked(api.getDeviations).mockResolvedValue([]);
    vi.mocked(api.getRunHistory).mockResolvedValue([]);
  });

  it('loads targets and shows the selected target host in the config panel', async () => {
    render(<App />);
    await waitFor(() => expect(api.getMap).toHaveBeenCalledWith(1));
    // Scoped to .config-panel: TargetForm (in Sidebar) also defaults its own
    // interval-seconds input to 60, so an unscoped getByDisplayValue('60') matches both.
    const configPanel = document.querySelector('.config-panel') as HTMLElement;
    expect(configPanel).not.toBeNull();
    expect(within(configPanel).getByDisplayValue('60')).toBeInTheDocument();
  });

  it('renders the theme switcher in the header', async () => {
    render(<App />);
    await waitFor(() => expect(api.getMap).toHaveBeenCalledWith(1));
    const header = document.querySelector('.app-header') as HTMLElement;
    expect(within(header).getByLabelText('Patch Panel')).toBeInTheDocument();
  });

  it('renders the map full-width above a bottom row containing the raw-values table and deviation timeline', async () => {
    render(<App />);
    await waitFor(() => expect(api.getMap).toHaveBeenCalledWith(1));
    expect(api.getRunHistory).toHaveBeenCalledWith(1, 1);

    const mainEl = document.querySelector('main') as HTMLElement;
    const mainChildClasses = Array.from(mainEl.children).map((el) => el.className);
    const mapIndex = mainChildClasses.findIndex((c) => c.includes('network-map'));
    const bottomIndex = mainChildClasses.findIndex((c) => c.includes('bottom-panels'));
    expect(mapIndex).toBeGreaterThan(-1);
    expect(bottomIndex).toBeGreaterThan(mapIndex);

    const bottomPanels = mainEl.children[bottomIndex] as HTMLElement;
    const children = Array.from(bottomPanels.children).map((el) => el.className);
    expect(children[0]).toContain('raw-mtr-panel');
    expect(children[1]).toContain('deviation-timeline');
  });

  it('scrubs to a historical point in time when a deviation is clicked and can return to live', async () => {
    const deviations: Deviation[] = [
      { id: 1, ttl: 1, oldHost: 'A', newHost: 'B', detectedAt: '2026-07-06T10:00:00.000Z' },
    ];
    const historyResult: HistoryResult = {
      at: '2026-07-06T10:00:00.000Z',
      active: [{ ttl: 1, host: 'A' }],
    };
    vi.mocked(api.getDeviations).mockResolvedValue(deviations);
    vi.mocked(api.getHistory).mockResolvedValue(historyResult);

    render(<App />);
    await waitFor(() => expect(api.getMap).toHaveBeenCalledWith(1));

    const scrubButton = await screen.findByText(/A -> B/);
    fireEvent.click(scrubButton);

    await waitFor(() =>
      expect(api.getHistory).toHaveBeenCalledWith(1, '2026-07-06T10:00:00.000Z'),
    );

    expect(await screen.findByText(/back to live/i)).toBeInTheDocument();
  });
});
