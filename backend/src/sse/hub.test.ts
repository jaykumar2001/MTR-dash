import { describe, expect, it, vi } from 'vitest';
import { SseHub } from './hub.js';

describe('SseHub', () => {
  it('delivers published events only to subscribers of that target', () => {
    const hub = new SseHub();
    const listenerA = vi.fn();
    const listenerB = vi.fn();
    hub.subscribe(1, listenerA);
    hub.subscribe(2, listenerB);

    hub.publish(1, { type: 'run', runId: 1 });

    expect(listenerA).toHaveBeenCalledWith({ type: 'run', runId: 1 });
    expect(listenerB).not.toHaveBeenCalled();
  });

  it('stops delivering events after unsubscribe', () => {
    const hub = new SseHub();
    const listener = vi.fn();
    const unsubscribe = hub.subscribe(1, listener);
    unsubscribe();
    hub.publish(1, { type: 'run', runId: 1 });
    expect(listener).not.toHaveBeenCalled();
  });
});
