import { useEffect } from 'react';

export function useSSE(targetId: number | null, onEvent: (event: unknown) => void): void {
  useEffect(() => {
    if (targetId === null) return;
    const source = new EventSource(`/api/targets/${targetId}/stream`);
    const handler = (e: MessageEvent) => onEvent(JSON.parse(e.data));
    source.addEventListener('run', handler);
    return () => {
      source.removeEventListener('run', handler);
      source.close();
    };
  }, [targetId, onEvent]);
}
