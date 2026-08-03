import { DEFAULT_ATTRS } from '../screenBuffer.js';

// The "None" emulation: no escape-sequence interpretation at all - a plain
// teletype. It also doubles as the base class for real emulations, which
// override processInput()/encodeKey() but reuse handleBasicControl() for the
// control codes every emulation shares (BS/TAB/LF/CR/BEL), so that logic
// isn't duplicated in each subclass's state machine.
export class TerminalEmulation {
  constructor(screen, hooks = {}) {
    this.screen = screen;
    this.onBell = hooks.onBell || (() => {});
    this.sendToDevice = hooks.sendToDevice || (() => {});
    this.currentAttrs = DEFAULT_ATTRS;
  }

  /** Returns true if the control code was consumed (including "swallowed, no effect"). */
  handleBasicControl(code) {
    switch (code) {
      case 0x08: this.screen.moveLeft(1); return true;
      case 0x09:
        this.screen.setPosition(this.screen.cursorRow, Math.min(this.screen.cols - 1, (Math.floor(this.screen.cursorCol / 8) + 1) * 8));
        return true;
      case 0x0A:
        this.screen.cursorRow++;
        if (this.screen.cursorRow >= this.screen.rows) { this.screen.scrollUp(); this.screen.cursorRow = this.screen.rows - 1; }
        return true;
      case 0x0D:
        this.screen.cursorCol = 0;
        return true;
      case 0x07:
        this.onBell();
        return true;
      default:
        // Any other control code (including ESC, 0x1B) is silently
        // swallowed rather than rendered as garbage.
        return code < 0x20;
    }
  }

  processInput(text) {
    for (const ch of text) {
      const code = ch.charCodeAt(0);
      if (this.handleBasicControl(code)) continue;
      this.screen.putChar(ch, this.currentAttrs);
    }
  }

  /** Returns the bytes to send for a special (non-printable) key, or null for no-op. */
  encodeKey(_key, _event) {
    return null;
  }

  /** Resets SGR/escape-parser state - called alongside clearing the screen buffer, so stale colors/bold or a half-parsed escape sequence don't survive a reset. */
  reset() {
    this.currentAttrs = DEFAULT_ATTRS;
  }
}
