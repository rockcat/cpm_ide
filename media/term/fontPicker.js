import { $ } from './dom.js';

// The Local Font Access API (window.queryLocalFonts) is experimental and
// gated behind a permission prompt - not guaranteed to exist or be granted
// in every environment a VS Code webview runs in, so every entry point here
// is feature-detected/try-caught and just leaves the font control hidden
// (its default state in terminal.html) rather than erroring.
export function isLocalFontAccessSupported() {
  return typeof window.queryLocalFonts === 'function';
}

// queryLocalFonts() reports font *faces* (family + style/weight), not
// whether a family is monospaced - there's no such flag on FontData. Instead,
// render a narrow-glyph run and a wide-glyph run in the same font at a large
// size and compare their measured widths: in a fixed-pitch font every glyph
// has the same advance width, so the two runs come out equal.
function isMonospaceFamily(family) {
  const canvas = isMonospaceFamily._canvas || (isMonospaceFamily._canvas = document.createElement('canvas'));
  const ctx = canvas.getContext('2d');
  ctx.font = `72px "${family}"`;
  const narrow = ctx.measureText('iiiiiiiiii').width;
  const wide = ctx.measureText('WWWWWWWWWW').width;
  return narrow > 0 && Math.abs(narrow - wide) < 0.5;
}

async function listMonospaceFontFamilies() {
  const fonts = await window.queryLocalFonts();
  const families = [...new Set(fonts.map(f => f.family))].sort((a, b) => a.localeCompare(b));
  return families.filter(isMonospaceFamily);
}

// Populates and wires the font-family dropdown if the Local Font Access API
// is available and grants permission; otherwise the control stays hidden -
// there's nothing to list without it.
export async function initFontPicker({ currentFont, saveSetting, onFontChange }) {
  if (!isLocalFontAccessSupported()) return;

  let families;
  try {
    families = await listMonospaceFontFamilies();
  } catch (err) {
    console.warn('[Webview] queryLocalFonts unavailable (permission denied?):', err);
    return;
  }
  if (families.length === 0) return;

  // Keep a previously-saved font selectable even if this run's detection
  // heuristic or enumeration missed it (e.g. a font moved/renamed).
  if (currentFont && !families.includes(currentFont)) {
    families = [currentFont, ...families];
  }

  const sel = $('font-family');
  sel.innerHTML = '';
  families.forEach(family => {
    const opt = document.createElement('option');
    opt.value = family;
    opt.textContent = family;
    if (family === currentFont) opt.selected = true;
    sel.appendChild(opt);
  });
  $('font-control').hidden = false;

  sel.addEventListener('change', () => {
    saveSetting('fontFamily', sel.value);
    onFontChange(sel.value);
  });
}
