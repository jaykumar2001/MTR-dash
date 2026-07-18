import type { Deviation } from '../types.js';

interface DeviationTimelineProps {
  deviations: Deviation[];
  onScrub: (at: string) => void;
}

export function DeviationTimeline({ deviations, onScrub }: DeviationTimelineProps) {
  return (
    <div className="deviation-timeline">
      <h3>Deviations</h3>
      <ul>
        {deviations.map((d) => (
          <li key={d.id}>
            <button onClick={() => onScrub(d.detectedAt)}>
              {new Date(d.detectedAt).toLocaleString()} — ttl {d.ttl}: {d.oldHost ?? '(none)'} -&gt;{' '}
              {d.newHost}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
