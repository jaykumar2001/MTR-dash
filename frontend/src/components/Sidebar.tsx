import type { Target } from '../types.js';
import { TargetForm, type TargetFormValues } from './TargetForm.js';

interface SidebarProps {
  targets: Target[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  onCreate: (values: TargetFormValues) => void;
  onDelete: (id: number) => void;
}

export function Sidebar({ targets, selectedId, onSelect, onCreate, onDelete }: SidebarProps) {
  return (
    <aside className="sidebar">
      <h2>Targets</h2>
      <ul>
        {targets.map((t) => (
          <li key={t.id} className={t.id === selectedId ? 'selected' : ''}>
            <button onClick={() => onSelect(t.id)}>{t.host}</button>
            <button aria-label={`delete-${t.id}`} onClick={() => onDelete(t.id)}>
              &times;
            </button>
          </li>
        ))}
      </ul>
      <TargetForm onSubmit={onCreate} />
    </aside>
  );
}
