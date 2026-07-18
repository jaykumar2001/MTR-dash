type Listener = (event: unknown) => void;

export class SseHub {
  private listeners = new Map<number, Set<Listener>>();

  subscribe(targetId: number, listener: Listener): () => void {
    if (!this.listeners.has(targetId)) this.listeners.set(targetId, new Set());
    this.listeners.get(targetId)!.add(listener);
    return () => {
      this.listeners.get(targetId)?.delete(listener);
    };
  }

  publish(targetId: number, event: unknown): void {
    for (const listener of this.listeners.get(targetId) ?? []) listener(event);
  }
}
