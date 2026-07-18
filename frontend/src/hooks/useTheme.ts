import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_THEME, THEMES } from '../lib/themes.js';

const STORAGE_KEY = 'mtr-dash-theme';

function isKnownTheme(value: string | null): value is string {
  return value !== null && THEMES.some((t) => t.id === value);
}

function readStoredTheme(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isKnownTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function useTheme(): [string, (id: string) => void] {
  const [theme, setThemeState] = useState<string>(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setTheme = useCallback((id: string) => {
    setThemeState(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // localStorage unavailable (e.g. private browsing) — theme still
      // applies for this session, it just won't persist across reloads.
    }
  }, []);

  return [theme, setTheme];
}
