// Light/dark toggle. index.html sets the initial data-theme before first paint.
export function toggleTheme() {
  const root = document.documentElement;
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* storage blocked: the choice lasts for this visit */ }
}
