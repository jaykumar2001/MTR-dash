import { THEMES } from '../lib/themes.js';

interface ThemeSwitcherProps {
  theme: string;
  onSelect: (id: string) => void;
}

export function ThemeSwitcher({ theme, onSelect }: ThemeSwitcherProps) {
  return (
    <div className="theme-switcher">
      {THEMES.map((t) => (
        <button
          key={t.id}
          type="button"
          className={`theme-swatch${t.id === theme ? ' active' : ''}`}
          style={{ background: t.accent }}
          title={t.label}
          aria-label={t.label}
          onClick={() => onSelect(t.id)}
        />
      ))}
    </div>
  );
}
