import { TerminalEmulation } from './base.js';
import { DEFAULT_ATTRS } from '../screenBuffer.js';

// A practical VT100/ANSI.SYS-ish subset: cursor movement, cursor position,
// erase display/line, and SGR (color/bold/underline/reverse). Unrecognized
// CSI final bytes are consumed without effect, same "fail closed" philosophy
// as VT52's default case, rather than leaking raw escape bytes to the screen.
export class AnsiEmulation extends TerminalEmulation {
  constructor(screen, hooks) {
    super(screen, hooks);
    this.state = 'NORMAL'; // NORMAL | ESCAPE | CSI
    this.params = '';
  }

  reset() {
    super.reset();
    this.state = 'NORMAL';
    this.params = '';
  }

  processInput(text) {
    for (const ch of text) {
      const code = ch.charCodeAt(0);

      if (this.state === 'CSI') {
        if ((ch >= '0' && ch <= '9') || ch === ';') { this.params += ch; continue; }
        this.state = 'NORMAL';
        this.handleCsi(ch, this.params);
        this.params = '';
        continue;
      }
      if (this.state === 'ESCAPE') {
        this.state = ch === '[' ? 'CSI' : 'NORMAL';
        if (this.state === 'CSI') this.params = '';
        continue;
      }

      if (code === 0x1B) { this.state = 'ESCAPE'; continue; }
      if (this.handleBasicControl(code)) continue;

      this.screen.putChar(ch, this.currentAttrs);
    }
  }

  handleCsi(final, paramStr) {
    const params = paramStr.split(';').filter(p => p !== '').map(Number);
    const p = (i, def) => (Number.isNaN(params[i]) || params[i] === undefined ? def : params[i]);

    switch (final) {
      case 'A': this.screen.moveUp(p(0, 1)); break;
      case 'B': this.screen.moveDown(p(0, 1)); break;
      case 'C': this.screen.moveRight(p(0, 1)); break;
      case 'D': this.screen.moveLeft(p(0, 1)); break;
      case 'H':
      case 'f':
        this.screen.setPosition(p(0, 1) - 1, p(1, 1) - 1);
        break;
      case 'J': this.eraseDisplay(p(0, 0)); break;
      case 'K': this.eraseLineParam(p(0, 0)); break;
      case 'm': this.applySgr(params.length ? params : [0]); break;
      default: break;
    }
  }

  eraseDisplay(mode) {
    if (mode === 0) this.screen.eraseToEndOfScreen(this.currentAttrs);
    else if (mode === 1) this.screen.eraseToStartOfScreen(this.currentAttrs);
    else this.screen.eraseScreen(this.currentAttrs);
  }

  eraseLineParam(mode) {
    if (mode === 0) this.screen.eraseToEndOfLine(this.currentAttrs);
    else if (mode === 1) this.screen.eraseToStartOfLine(this.currentAttrs);
    else this.screen.eraseLine(this.currentAttrs);
  }

  applySgr(codes) {
    let attrs = this.currentAttrs === DEFAULT_ATTRS ? null : { ...this.currentAttrs };
    for (const code of codes) {
      if (code === 0) { attrs = null; continue; }
      if (!attrs) attrs = { ...DEFAULT_ATTRS };
      if (code === 1) attrs.bold = true;
      else if (code === 4) attrs.underline = true;
      else if (code === 7) attrs.reverse = true;
      else if (code === 22) attrs.bold = false;
      else if (code === 24) attrs.underline = false;
      else if (code === 27) attrs.reverse = false;
      else if (code >= 30 && code <= 37) attrs.fg = code - 30;
      else if (code === 39) attrs.fg = null;
      else if (code >= 40 && code <= 47) attrs.bg = code - 40;
      else if (code === 49) attrs.bg = null;
      else if (code >= 90 && code <= 97) attrs.fg = code - 90 + 8;
      else if (code >= 100 && code <= 107) attrs.bg = code - 100 + 8;
    }
    this.currentAttrs = attrs ? Object.freeze(attrs) : DEFAULT_ATTRS;
  }

  encodeKey(key) {
    switch (key) {
      case 'ArrowUp': return '\x1B[A';
      case 'ArrowDown': return '\x1B[B';
      case 'ArrowRight': return '\x1B[C';
      case 'ArrowLeft': return '\x1B[D';
      case 'Home': return '\x1B[H';
      case 'End': return '\x1B[F';
      case 'Insert': return '\x1B[2~';
      case 'Delete': return '\x1B[3~';
      case 'PageUp': return '\x1B[5~';
      case 'PageDown': return '\x1B[6~';
      default: return super.encodeKey(key);
    }
  }
}
