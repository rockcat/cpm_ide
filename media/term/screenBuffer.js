// A bounded character grid + cursor, matching how CP/M full-screen programs
// (WordStar, ZDE, etc.) actually address the screen via cursor escape
// sequences - not a scrolling text log. Emulation-agnostic: it knows nothing
// about escape sequences, only how to place/move/erase cells and render them.
// Each cell carries an `attrs` reference (color/bold/underline/reverse) so
// ANSI SGR state can be represented - most cells across a run share the same
// frozen attrs object, which render() exploits to group runs into one <span>
// without a deep-equality check.

export const DEFAULT_ATTRS = Object.freeze({ fg: null, bg: null, bold: false, underline: false, reverse: false });

// Lines pushed off the top of the live grid, kept around so the user can
// scroll back through recent output instead of losing it. Capped so the DOM
// doesn't grow without bound over a long session.
const MAX_SCROLLBACK = 2000;

// A 16-color ANSI palette (standard + bright). Reasonable defaults for a
// CP/M ANSI terminal - not trying to match any one real hardware's exact hues.
const PALETTE = {
  0: '#000000', 1: '#cc0000', 2: '#4e9a06', 3: '#c4a000',
  4: '#3465a4', 5: '#75507b', 6: '#06989a', 7: '#d3d7cf',
  8: '#555753', 9: '#ef2929', 10: '#8ae234', 11: '#fce94f',
  12: '#729fcf', 13: '#ad7fa8', 14: '#34e2e2', 15: '#eeeeec',
};
const DEFAULT_FG_CSS = 'var(--vscode-terminal-foreground, #cccccc)';
const DEFAULT_BG_CSS = 'var(--vscode-terminal-background, #1e1e1e)';

// Sets style properties via the CSSOM (element.style.xxx = ...) rather than
// building a `style="..."` markup string for innerHTML: the webview's CSP
// (style-src, no 'unsafe-inline') blocks markup-based inline styles, but
// direct style-property assignment isn't a CSP-restricted surface.
function applyCellStyle(style, attrs) {
  if (attrs === DEFAULT_ATTRS) return;
  let fgCss = (attrs.fg == null ? null : PALETTE[attrs.fg]) ?? DEFAULT_FG_CSS;
  let bgCss = (attrs.bg == null ? null : PALETTE[attrs.bg]) ?? DEFAULT_BG_CSS;
  if (attrs.reverse) { const t = fgCss; fgCss = bgCss; bgCss = t; }
  if (fgCss !== DEFAULT_FG_CSS) style.color = fgCss;
  if (bgCss !== DEFAULT_BG_CSS) style.background = bgCss;
  if (attrs.bold) style.fontWeight = 'bold';
  if (attrs.underline) style.textDecoration = 'underline';
}

export class ScreenBuffer {
  constructor() {
    this.cols = 80;
    this.rows = 25;
    this.grid = [];
    this.scrollback = [];
    this.cursorRow = 0;
    this.cursorCol = 0;
    this.init(this.cols, this.rows);
  }

  _blankRow(attrs = DEFAULT_ATTRS) {
    return Array.from({ length: this.cols }, () => ({ ch: ' ', attrs }));
  }

  init(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => this._blankRow());
    this.cursorRow = 0;
    this.cursorCol = 0;
  }

  clear() {
    this.scrollback = [];
    this.init(this.cols, this.rows);
  }

  putChar(ch, attrs = DEFAULT_ATTRS) {
    if (this.cursorCol >= this.cols) {
      this.cursorCol = 0;
      this.cursorRow++;
      if (this.cursorRow >= this.rows) { this.scrollUp(); this.cursorRow = this.rows - 1; }
    }
    this.grid[this.cursorRow][this.cursorCol] = { ch, attrs };
    this.cursorCol++;
  }

  scrollUp() {
    const departingRow = this.grid.shift();
    let trimEnd = departingRow.length;
    while (trimEnd > 0 && departingRow[trimEnd - 1].ch === ' ' && departingRow[trimEnd - 1].attrs === DEFAULT_ATTRS) {
      trimEnd--;
    }
    this.scrollback.push(departingRow.slice(0, trimEnd));
    if (this.scrollback.length > MAX_SCROLLBACK) this.scrollback.shift();
    this.grid.push(this._blankRow());
  }

  scrollDown() {
    this.grid.pop();
    this.grid.unshift(this._blankRow());
  }

  moveUp(n = 1) { this.cursorRow = Math.max(0, this.cursorRow - n); }
  moveDown(n = 1) { this.cursorRow = Math.min(this.rows - 1, this.cursorRow + n); }
  moveLeft(n = 1) { this.cursorCol = Math.max(0, this.cursorCol - n); }
  moveRight(n = 1) { this.cursorCol = Math.min(this.cols - 1, this.cursorCol + n); }

  setPosition(row, col) {
    this.cursorRow = Math.max(0, Math.min(this.rows - 1, row));
    this.cursorCol = Math.max(0, Math.min(this.cols - 1, col));
  }

  home() { this.setPosition(0, 0); }

  eraseToEndOfLine(attrs = DEFAULT_ATTRS) {
    for (let c = this.cursorCol; c < this.cols; c++) this.grid[this.cursorRow][c] = { ch: ' ', attrs };
  }

  eraseToStartOfLine(attrs = DEFAULT_ATTRS) {
    for (let c = 0; c <= this.cursorCol; c++) this.grid[this.cursorRow][c] = { ch: ' ', attrs };
  }

  eraseLine(attrs = DEFAULT_ATTRS) {
    this.grid[this.cursorRow] = this._blankRow(attrs);
  }

  eraseToEndOfScreen(attrs = DEFAULT_ATTRS) {
    this.eraseToEndOfLine(attrs);
    for (let r = this.cursorRow + 1; r < this.rows; r++) this.grid[r] = this._blankRow(attrs);
  }

  eraseToStartOfScreen(attrs = DEFAULT_ATTRS) {
    this.eraseToStartOfLine(attrs);
    for (let r = 0; r < this.cursorRow; r++) this.grid[r] = this._blankRow(attrs);
  }

  eraseScreen(attrs = DEFAULT_ATTRS) {
    for (let r = 0; r < this.rows; r++) this.grid[r] = this._blankRow(attrs);
  }

  // Text runs sharing the same attrs reference collapse into one plain text
  // node (the common case); a run needs its own <span> only when it carries
  // non-default attrs or is the cursor cell.
  _appendRow(parent, row, cursorCol) {
    let spanAttrs = null;
    let buf = '';
    const flush = () => {
      if (!buf) return;
      parent.appendChild(spanAttrs === DEFAULT_ATTRS
        ? document.createTextNode(buf)
        : this._makeSpan(buf, spanAttrs));
      buf = '';
    };
    row.forEach((cell, c) => {
      if (c === cursorCol) {
        flush();
        const span = this._makeSpan(cell.ch, cell.attrs);
        span.classList.add('term-cursor');
        parent.appendChild(span);
        spanAttrs = null;
        return;
      }
      if (cell.attrs !== spanAttrs) { flush(); spanAttrs = cell.attrs; }
      buf += cell.ch;
    });
    flush();
  }

  _makeSpan(text, attrs) {
    const span = document.createElement('span');
    span.textContent = text;
    applyCellStyle(span.style, attrs);
    return span;
  }

  render(outEl, autoScroll = true) {
    const frag = document.createDocumentFragment();
    const rows = [
      ...this.scrollback.map(row => ({ row, cursorCol: -1 })),
      ...this.grid.map((row, r) => ({ row, cursorCol: r === this.cursorRow ? this.cursorCol : -1 })),
    ];
    rows.forEach(({ row, cursorCol }, i) => {
      this._appendRow(frag, row, cursorCol);
      if (i < rows.length - 1) frag.appendChild(document.createTextNode('\n'));
    });
    outEl.replaceChildren(frag);
    if (autoScroll) outEl.scrollTop = outEl.scrollHeight;
  }
}
