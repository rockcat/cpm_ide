import { $ } from './term/dom.js';
import { ScreenBuffer } from './term/screenBuffer.js';
import { TerminalEmulation } from './term/emulation/base.js';

// The DEBUG panel only ever receives short, plain DDT prompt/status lines
// (SerialTerminal.routeDdtResponse() keeps a debugged program's own output -
// the thing that might need real VT52/ANSI cursor addressing - in the main
// terminal instead), so the base "no escape interpretation" emulation is all
// that's needed here: just CR/LF/BS/BEL handling plus plain character output.
//
// DDT_MODE has no free-typing: the Step/Step Over/Go buttons are the only
// way a command ever reaches DDT (see SerialTerminal.stepDdt()/goDdt()),
// which is what lets the server always know exactly which response it's
// looking for. This panel is purely a display plus those three buttons.
(function () {
  'use strict';
  try {
    const vscode = acquireVsCodeApi();

    const screen = new ScreenBuffer();
    const emulation = new TerminalEmulation(screen, {});

    let userScrolledUp = false;
    function render() {
      screen.render($('output'), !userScrolledUp);
    }

    // Scales the grid's font size to fill the panel's available space - the
    // same approach terminal.js uses for the main CP/M Terminal.
    function applyPanelSize() {
      const out = $('output');
      const style = getComputedStyle(out);
      const lineHeightRatio = 1.4;

      const measurer = document.createElement('span');
      measurer.style.position = 'absolute';
      measurer.style.visibility = 'hidden';
      measurer.style.whiteSpace = 'pre';
      measurer.style.fontFamily = style.fontFamily;
      measurer.style.fontSize = '100px';
      measurer.textContent = '0'.repeat(screen.cols);
      document.body.appendChild(measurer);
      const charWidthPerPx = measurer.getBoundingClientRect().width / screen.cols / 100;
      document.body.removeChild(measurer);

      const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const availWidth = out.clientWidth - paddingX;
      const availHeight = out.clientHeight - paddingY;

      const fontSizeForWidth = availWidth / (screen.cols * charWidthPerPx);
      const fontSizeForHeight = availHeight / (screen.rows * lineHeightRatio);
      const fontSize = Math.max(6, Math.floor(Math.min(fontSizeForWidth, fontSizeForHeight)));

      out.style.fontSize = fontSize + 'px';
      out.style.lineHeight = String(lineHeightRatio);
    }

    new ResizeObserver(() => applyPanelSize()).observe($('output'));

    // Tracks whether the user has scrolled up to read history, so new
    // output doesn't yank them back down mid-read.
    $('output').addEventListener('scroll', () => {
      const out = $('output');
      userScrolledUp = out.scrollHeight - out.scrollTop - out.clientHeight > 4;
    });

    // No keystroke input - see the file-level note. tabindex/focus stay
    // just so arrow/page keys can scroll this view like any other
    // scrollable pane, not to accept typed commands.
    $('output').addEventListener('click', () => $('output').focus());

    // DDT prints this line (flags packed with no separators, then
    // space-separated register assignments, then an optional disassembly
    // of the instruction at P) after every X (examine), T (single-step),
    // and breakpoint hit - e.g. "C0Z0M0E0I0 A=00 B=0000 D=0000 H=0000
    // S=0100 P=0100 MVI  E,48". Scanning every such line (not just the one
    // launchDdt() requests via X) is what keeps the register section
    // updated through single-stepping and breakpoints too.
    //
    // Crucially, P= here is NOT always "the current PC": after a T, DDT
    // reprints the register/disasm state as it was BEFORE that step (i.e.
    // whatever the previous response already showed) and only appends a
    // trailing "*nnnn" - with no disassembly of its own - to say where
    // execution actually landed. E.g. stepping over a 2-byte "MVI E,48" at
    // 0100 prints "...P=0100 MVI  E,48*0102", not "P=0102". Only X's own
    // response (never a T's) reliably pairs the true current PC with its
    // disassembly - that asymmetry is exactly why SerialTerminal chases a
    // fresh X after every T completes too, not just after a G stop. This
    // trailing address is captured as its own group (13) so a real PC is
    // still available for the listing/Step Over even in the brief window
    // before that auto-X's clean response arrives and corrects reg-disasm.
    const REGISTER_LINE = /C([01])Z([01])M([01])E([01])I([01])\s+A=([0-9A-F]{2})\s+B=([0-9A-F]{4})\s+D=([0-9A-F]{4})\s+H=([0-9A-F]{4})\s+S=([0-9A-F]{4})\s+P=([0-9A-F]{4})(?:\s+(\S.*?))?(?:\*([0-9A-F]{4}))?\s*$/;
    const MAX_REG_LINE_BUFFER = 200; // a real register line is well under 100 chars

    function setFlag(id, value) {
      const el = $(id);
      el.textContent = value;
      el.classList.toggle('set', value === '1');
    }

    // Step/Step Over/Go must not be clickable while DDT might still be
    // running the debuggee (or hasn't booted far enough to read the
    // console yet) - a command sent in that window doesn't reach a DDT
    // prompt at all, it lands mid-stream in whatever the target program is
    // doing and gets garbled or silently dropped. Re-enabling them is
    // driven entirely by the server's authoritative 'ready' message (see
    // the window message handler below) - SerialTerminal knows exactly
    // which response it's waiting for and when it's complete, so this no
    // longer has to guess from whether a register line happened to parse.
    // Each button click disables them again immediately, before any
    // response has come back.
    function setStepButtonsEnabled(enabled) {
      $('btn-step').disabled = !enabled;
      $('btn-step-over').disabled = !enabled;
      $('btn-go').disabled = !enabled;
    }

    function updateRegisters(m) {
      $('reg-A').textContent = m[6];
      $('reg-B').textContent = m[7];
      $('reg-D').textContent = m[8];
      $('reg-H').textContent = m[9];
      $('reg-S').textContent = m[10];
      // m[13] (see REGISTER_LINE's comment) is where execution actually is
      // right now, when present - m[11] alone would be one step stale.
      const currentPc = m[13] || m[11];
      $('reg-P').textContent = currentPc;
      setFlag('flag-C', m[1]);
      setFlag('flag-Z', m[2]);
      setFlag('flag-M', m[3]);
      setFlag('flag-E', m[4]);
      setFlag('flag-I', m[5]);
      $('reg-disasm').textContent = m[12] || '';
      updateListingDisplay(currentPc);
    }

    /** Blanks the registers/flags/listing/output back to their startup state - see the 'reset' message handler below. */
    function resetDisplay() {
      $('reg-A').textContent = '--';
      $('reg-B').textContent = '----';
      $('reg-D').textContent = '----';
      $('reg-H').textContent = '----';
      $('reg-S').textContent = '----';
      $('reg-P').textContent = '----';
      setFlag('flag-C', '-');
      setFlag('flag-Z', '-');
      setFlag('flag-M', '-');
      setFlag('flag-E', '-');
      setFlag('flag-I', '-');
      $('reg-disasm').textContent = '';
      listingLines = [];
      $('listing').hidden = true;
      regLineBuffer = '';
      screen.clear();
      render();
      setStepButtonsEnabled(false);
    }

    // Source-listing context (loaded server-side from a local .lst matching
    // the .com under debug, if one exists - see SerialTerminal's
    // loadDdtListingFromPath()). Kept as {address, text} entries in file
    // order; re-resolved against the current PC on every register update so
    // it tracks single-stepping/breakpoints the same way the registers do.
    let listingLines = [];

    // The listing line whose address is the closest one at-or-before `pc` -
    // not always an exact match, since a multi-byte instruction's PC can
    // land anywhere within it and not every source line emits code (blank
    // lines, comments, EQUs). Scans the whole array rather than assuming
    // strictly increasing addresses (macros/ORGs can reorder them) but still
    // prefers the highest qualifying address, then the latest such line in
    // file order, matching normal top-to-bottom execution.
    function findClosestListingIndex(pc) {
      let matchIdx = -1;
      let bestAddr = -1;
      for (let i = 0; i < listingLines.length; i++) {
        const addr = listingLines[i].address;
        if (addr <= pc && addr >= bestAddr) {
          bestAddr = addr;
          matchIdx = i;
        }
      }
      return matchIdx;
    }

    function updateListingDisplay(pcHex) {
      const container = $('listing');
      const pc = parseInt(pcHex, 16);
      const matchIdx = Number.isNaN(pc) ? -1 : findClosestListingIndex(pc);
      if (matchIdx === -1) {
        container.hidden = true;
        return;
      }

      container.hidden = false;
      const rows = container.querySelectorAll('.listing-line');
      const center = Math.floor(rows.length / 2);
      rows.forEach((row, i) => {
        const idx = matchIdx - center + i;
        const line = listingLines[idx];
        row.textContent = line ? line.text : '';
        row.classList.toggle('current', idx === matchIdx);
      });
    }

    // Serial chunks can split this line across multiple 'data' messages, so
    // unterminated text accumulates across calls the same way the main
    // terminal/DDT prompt-detection buffers do server-side.
    let regLineBuffer = '';
    function scanForRegisters(text) {
      regLineBuffer += text;
      if (regLineBuffer.length > MAX_REG_LINE_BUFFER) {
        regLineBuffer = regLineBuffer.slice(-MAX_REG_LINE_BUFFER);
      }
      const lines = regLineBuffer.split(/\r\n|\r|\n/);
      regLineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const m = REGISTER_LINE.exec(line);
        if (m) updateRegisters(m);
      }
      // Also try the still-accumulating remainder, in case a register line
      // is immediately followed by the "-" prompt with no newline of its
      // own to complete it.
      const partial = REGISTER_LINE.exec(regLineBuffer);
      if (partial) updateRegisters(partial);
    }

    // 8080-mnemonic call variants DDT disassembles a CALL-family instruction
    // as (unconditional CALL, plus the eight condition-coded forms) - all
    // are 3 bytes (1 opcode + 2-byte address) regardless of which, so
    // "step over" always resumes at P+3.
    const CALL_MNEMONICS = new Set(['CALL', 'CC', 'CNC', 'CZ', 'CNZ', 'CP', 'CM', 'CPE', 'CPO']);

    function isCallInstruction(disasm) {
      if (!disasm) return false;
      return CALL_MNEMONICS.has(disasm.trim().split(/\s+/)[0].toUpperCase());
    }

    /** `pcHex` + 3, wrapped to 16 bits, as a 4-digit uppercase hex string - the address right after a 3-byte CALL instruction. */
    function addressAfterCall(pcHex) {
      const pc = parseInt(pcHex, 16);
      if (Number.isNaN(pc)) return null;
      return ((pc + 3) & 0xffff).toString(16).toUpperCase().padStart(4, '0');
    }

    $('btn-step').addEventListener('click', () => {
      setStepButtonsEnabled(false);
      vscode.postMessage({ command: 'step' });
    });
    $('btn-go').addEventListener('click', () => {
      setStepButtonsEnabled(false);
      vscode.postMessage({ command: 'go' });
    });

    // Same as Step, unless the instruction at the current PC (from the most
    // recent register-line parse) is a CALL - then it runs the call to
    // completion with a breakpoint right after it, instead of stepping
    // into the callee one instruction at a time.
    $('btn-step-over').addEventListener('click', () => {
      setStepButtonsEnabled(false);
      const disasm = $('reg-disasm').textContent;
      const pc = $('reg-P').textContent;
      if (isCallInstruction(disasm)) {
        const breakpoint = addressAfterCall(pc);
        if (breakpoint) {
          vscode.postMessage({ command: 'go', start: pc, breakpoint });
          return;
        }
      }
      vscode.postMessage({ command: 'step' });
    });

    // Escape hatches - always clickable regardless of setStepButtonsEnabled,
    // since both are meant to work even when DDT looks stuck/unresponsive.
    $('btn-restart').addEventListener('click', () => {
      vscode.postMessage({ command: 'restart' });
    });

    // Goes through the extension host (endDdtSession()) rather than closing
    // locally, since ddtMode's routing state needs to be reset there too -
    // otherwise SerialTerminal would keep steering incoming data at a DEBUG
    // panel that no longer exists to show it.
    $('btn-end-session').addEventListener('click', () => {
      vscode.postMessage({ command: 'endSession' });
    });

    window.addEventListener('message', e => {
      const msg = e.data;
      if (msg.command === 'data') {
        emulation.processInput(msg.text);
        scanForRegisters(msg.text);
        render();
        // sessionEnded (DebugPanel, on serialTerminal's
        // onDdtModeChanged(false)) means there's no DDT prompt left to
        // send these at - leaving them enabled would let a click reach
        // stepDdt()/goDdt() after ddtMode has already gone false (a
        // harmless no-op server-side, but a stale, confusing UI state).
        if (msg.sessionEnded) {
          setStepButtonsEnabled(false);
        }
      } else if (msg.command === 'listing') {
        listingLines = msg.lines || [];
        updateListingDisplay($('reg-P').textContent);
      } else if (msg.command === 'ready') {
        setStepButtonsEnabled(true);
      } else if (msg.command === 'reset') {
        resetDisplay();
      }
    });

    render();
  } catch (err) {
    console.error('[DebugPanel] Fatal error:', err);
    document.body.innerHTML = '<pre style="color:red; padding:20px;">Script Error: ' + err.message + '\n\n' + err.stack + '</pre>';
  }
})();
