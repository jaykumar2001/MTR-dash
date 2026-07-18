export interface ThemePreset {
  id: string;
  label: string;
  accent: string;
}

export const THEMES: ThemePreset[] = [
  { id: 'dark-patch-panel', label: 'Patch Panel', accent: '#e8622c' },
  { id: 'dark-slate', label: 'Dark Slate', accent: '#2fb8c9' },
  { id: 'light-paper', label: 'Paper', accent: '#d1531f' },
  { id: 'light-slate', label: 'Light Slate', accent: '#0f7f8f' },
];

export const DEFAULT_THEME = 'dark-patch-panel';
