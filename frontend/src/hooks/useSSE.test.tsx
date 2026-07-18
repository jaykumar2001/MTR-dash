import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSSE } from './useSSE.js';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, handler: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(handler);
  }

  removeEventListener(type: string, handler: (e: MessageEvent) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((h) => h !== handler);
  }

  close() {
    this.closed = true;
  }

  emit(type: string, data: unknown) {
    for (const handler of this.listeners[type] ?? []) {
      handler({ data: JSON.stringify(data) } as MessageEvent);
    }
  }
}

describe('useSSE', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('opens a stream for the given target and forwards parsed events', () => {
    const onEvent = vi.fn();
    renderHook(() => useSSE(1, onEvent));

    const source = FakeEventSource.instances[0];
    expect(source.url).toBe('/api/targets/1/stream');
    source.emit('run', { type: 'run', runId: 5 });
    expect(onEvent).toHaveBeenCalledWith({ type: 'run', runId: 5 });
  });

  it('closes the previous stream when targetId changes', () => {
    const { rerender } = renderHook(({ id }) => useSSE(id, vi.fn()), {
      initialProps: { id: 1 },
    });
    const first = FakeEventSource.instances[0];
    rerender({ id: 2 });
    expect(first.closed).toBe(true);
  });

  it('does not open a stream when targetId is null', () => {
    renderHook(() => useSSE(null, vi.fn()));
    expect(FakeEventSource.instances).toHaveLength(0);
  });
});
