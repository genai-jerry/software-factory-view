/**
 * Theme preference: 'system' (default) follows prefers-color-scheme via CSS;
 * an explicit choice stamps data-theme on <html> and persists. applyTheme runs
 * before first render (main.tsx) so there is no flash of the wrong theme.
 */

export type ThemePref = "system" | "light" | "dark";

const KEY = "console-theme";

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

export function applyTheme(pref: ThemePref = getThemePref()): void {
  if (pref === "system") {
    localStorage.removeItem(KEY);
    delete document.documentElement.dataset.theme;
  } else {
    localStorage.setItem(KEY, pref);
    document.documentElement.dataset.theme = pref;
  }
}

export function cycleTheme(pref: ThemePref): ThemePref {
  return pref === "system" ? "light" : pref === "light" ? "dark" : "system";
}
