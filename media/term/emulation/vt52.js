import { TerminalEmulation } from './base.js';

// DEC Special Graphics character set, selected by ESC F (exited by ESC G).
const GRAPHICS_MAP = {
  '_': ' ', '`': '◆', 'a': '▒', 'b': '␉', 'c': '␌',
  'd': '␍', 'e': '␊', 'f': '°', 'g': '±', 'h': '␤',
  'i': '␋', 'j': '┘', 'k': '┐', 'l': '┌', 'm': '└',
  'n': '┼', 'o': '⎺', 'p': '⎻', 'q': '─', 'r': '⎼',
  's': '⎽', 't': '├', 'u': '┤', 'v': '┴', 'w': '┬',
  'x': '│', 'y': '≤', 'z': '≥', '{': 'π', '|': '≠',
  '}': '£', '~': '·',
};

export class Vt52Emulation extends TerminalEmulation {
  constructor(screen, hooks) {
    super(screen, hooks);
    this.state = 'NORMAL';
    this.escYRow = 0;
    this.graphicsMode = false;
  }

  reset() {
    super.reset();
    this.state = 'NORMAL';
    this.escYRow = 0;
    this.graphicsMode = false;
  }

  processInput(text) {
    for (const ch of text) {
      const code = ch.charCodeAt(0);

      if (this.state === 'ESCAPE_Y_ROW') {
        this.escYRow = Math.max(0, Math.min(this.screen.rows - 1, code - 32));
        this.state = 'ESCAPE_Y_COL';
        continue;
      }
      if (this.state === 'ESCAPE_Y_COL') {
        const col = Math.max(0, Math.min(this.screen.cols - 1, code - 32));
        this.screen.setPosition(this.escYRow, col);
        this.state = 'NORMAL';
        continue;
      }
      if (this.state === 'ESCAPE') {
        this.state = 'NORMAL';
        switch (ch) {
          case 'A': this.screen.moveUp(1); break;
          case 'B': this.screen.moveDown(1); break;
          case 'C': this.screen.moveRight(1); break;
          case 'D': this.screen.moveLeft(1); break;
          case 'H': this.screen.home(); break;
          case 'I': if (this.screen.cursorRow === 0) this.screen.scrollDown(); else this.screen.cursorRow--; break;
          case 'J': this.screen.eraseToEndOfScreen(); break;
          case 'K': this.screen.eraseToEndOfLine(); break;
          case 'Y': this.state = 'ESCAPE_Y_ROW'; break;
          case 'Z': this.sendToDevice('\x1B/Z'); break;
          case 'F': this.graphicsMode = true; break;
          case 'G': this.graphicsMode = false; break;
          default: break; // ESC = / > / < (keypad/ANSI mode) etc: no visual effect
        }
        continue;
      }

      if (code === 0x1B) { this.state = 'ESCAPE'; continue; }
      if (this.handleBasicControl(code)) continue;

      this.screen.putChar(this.graphicsMode ? (GRAPHICS_MAP[ch] || ch) : ch, this.currentAttrs);
    }
  }

  encodeKey(key) {
    switch (key) {
      case 'ArrowUp': return '\x1BA';
      case 'ArrowDown': return '\x1BB';
      case 'ArrowRight': return '\x1BC';
      case 'ArrowLeft': return '\x1BD';
      case 'Home': return '\x1BH';
      default: return super.encodeKey(key);
    }
  }
}
