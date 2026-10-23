// Light or dark theme. "auto" follows the device; the Tema buttons save a fixed choice on this device (common.js).
// Loaded in <head> before the page paints, so the page never shows up in the other theme first.
(() => {
  const root = document.documentElement, deviceDark = matchMedia('(prefers-color-scheme: dark)');
  function applyTheme() {
    let pick = 'auto';
    try { pick = localStorage.getItem('sp_theme') || 'auto'; } catch {}
    const theme = pick === 'auto' ? (deviceDark.matches ? 'dark' : 'light') : pick;
    root.dataset.theme = theme;
    root.dataset.themePick = pick;
    // The browser bar follows the theme in use: both theme-color tags get its colour.
    const metas = [...document.querySelectorAll('meta[name="theme-color"]')];
    metas.forEach((m) => { m.dataset.colour ??= m.content; });
    const colour = metas.find((m) => m.media.includes(theme))?.dataset.colour;
    if (colour) metas.forEach((m) => { m.content = colour; });
  }
  applyTheme();
  deviceDark.addEventListener('change', applyTheme);
  window.applyTheme = applyTheme;
})();
