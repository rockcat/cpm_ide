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

    // Scales the grid's font size to fill the panel's available width - unlike
    // terminal.js's version of this (which also fits screen.rows, since the
    // main terminal emulates a real fixed-size full-screen app), this panel
    // only ever shows a handful of short DDT prompt/status lines at a time
    // (see the file-level comment above), so there's no fixed row count to
    // fit on screen at once. Sizing by width alone lets the font be as large
    // as the panel is wide, and #output's own overflow-y:auto (terminal.css)
    // scrolls through anything taller than the visible area.
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
      const availWidth = out.clientWidth - paddingX;

      const fontSizeForWidth = availWidth / (screen.cols * charWidthPerPx);
      const fontSize = Math.max(6, Math.floor(fontSizeForWidth));

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
      listingRows = [];
      $('listing').hidden = true;
      $('listing').textContent = '';
      breakpoints = [null, null];
      savedBreakpoint1 = null;
      stepOverPending = false;
      updateBreakpointDisplay();
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

    // DOM row for each entry in listingLines, in the same order - built once
    // per 'listing' message (see buildListingRows()) and then just
    // toggled/scrolled on every register update rather than being torn down
    // and rebuilt, since the underlying listing doesn't change mid-session.
    let listingRows = [];

    // Up to two user-set breakpoints, each a 4-digit uppercase hex address
    // string or null if that slot is unset. This is the single source of
    // truth for both the Breakpoint 1/2 panel and the markers drawn in the
    // listing - see updateBreakpointDisplay(). Sent along with every 'go'
    // message (see the btn-go handler) as DDT's own `G,bp1,bp2` syntax.
    let breakpoints = [null, null];

    // While a Step Over is running a CALL to completion, slot 0 above holds
    // the step-over target instead of the user's real breakpoint 1 (see the
    // btn-step-over handler) - this is what that real value is saved into
    // so the 'ready' handler can put it back once the step-over completes.
    let savedBreakpoint1 = null;
    let stepOverPending = false;

    /** `n` (a listing line's numeric address) as a 4-digit uppercase hex string, e.g. 0x107 -> "0107". */
    function toHex4(n) {
      return n.toString(16).toUpperCase().padStart(4, '0');
    }

    // Reflects `breakpoints` into the Breakpoint 1/2 panel (address text +
    // clear-button enabled state) and onto the listing (which rows get the
    // marker dot) - the one place both are kept in sync, called after
    // anything mutates `breakpoints` or rebuilds the listing rows.
    function updateBreakpointDisplay() {
      for (let i = 0; i < 2; i++) {
        const addr = breakpoints[i];
        $(`breakpoint-${i + 1}`).textContent = addr ? `${addr}h` : '--';
        $(`breakpoint-${i + 1}-clear`).disabled = !addr;
      }
      listingRows.forEach(row => row.classList.toggle('breakpoint', breakpoints.includes(row.dataset.addr)));
    }

    /** Sets a breakpoint at `hexAddr` in the first free slot, or clears it if already set there - a no-op if both slots are already taken by other addresses. */
    function toggleBreakpointAtAddress(hexAddr) {
      const slot = breakpoints.indexOf(hexAddr);
      if (slot !== -1) {
        breakpoints[slot] = null;
      } else {
        const freeSlot = breakpoints.indexOf(null);
        if (freeSlot === -1) return;
        breakpoints[freeSlot] = hexAddr;
      }
      updateBreakpointDisplay();
    }

    $('breakpoint-1-clear').addEventListener('click', () => { breakpoints[0] = null; updateBreakpointDisplay(); });
    $('breakpoint-2-clear').addEventListener('click', () => { breakpoints[1] = null; updateBreakpointDisplay(); });

    // Event delegation over the listing container rather than a per-row
    // listener, since rows are torn down and rebuilt wholesale on every new
    // listing (see buildListingRows()).
    $('listing').addEventListener('click', e => {
      const row = e.target.closest('.listing-line');
      if (row) toggleBreakpointAtAddress(row.dataset.addr);
    });

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

    // Rebuilds the full set of listing rows (one per listingLines entry) in
    // the DOM so the whole listing is present at once and can be scrolled
    // natively, rather than only ever materializing a small window of rows
    // around the current PC.
    function buildListingRows() {
      const container = $('listing');
      container.textContent = '';
      listingRows = listingLines.map(line => {
        const row = document.createElement('div');
        row.className = 'listing-line';
        row.textContent = line.text;
        row.dataset.addr = toHex4(line.address);
        container.appendChild(row);
        return row;
      });
      updateBreakpointDisplay();
    }

    // Keeps enough blank space above and below the real listing rows that
    // even the first/last line in the file can still be scrolled all the
    // way to the vertical center of the view - without this, the current
    // line would only be able to approach the center, never reach it, once
    // fewer than half a screenful of real lines remain above or below it.
    function applyListingPadding() {
      const container = $('listing');
      const half = Math.round(container.clientHeight / 2) + 'px';
      container.style.paddingTop = half;
      container.style.paddingBottom = half;
    }
    new ResizeObserver(() => applyListingPadding()).observe($('listing'));

    function updateListingDisplay(pcHex) {
      const container = $('listing');
      const pc = parseInt(pcHex, 16);
      const matchIdx = Number.isNaN(pc) ? -1 : findClosestListingIndex(pc);
      if (matchIdx === -1) {
        container.hidden = true;
        return;
      }

      container.hidden = false;
      // The ResizeObserver above already keeps padding in sync with the
      // container's size, but its callback fires asynchronously - calling
      // this here too avoids a stale (e.g. zero) padding value on the very
      // first reveal, when hidden -> visible and the first scroll happen in
      // the same tick.
      applyListingPadding();
      listingRows.forEach((row, i) => row.classList.toggle('current', i === matchIdx));

      // Re-center the current line in the scrollable viewport on every step,
      // rather than only scrolling it into view when it's off-screen - this
      // is what keeps the PC pinned to the middle of the window as it moves.
      const row = listingRows[matchIdx];
      if (row) {
        container.scrollTop = row.offsetTop - (container.clientHeight - row.offsetHeight) / 2;
      }
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

    // Drops any breakpoint that sits at the current PC before a 'go' -
    // DDT would otherwise stop again immediately, right back where
    // execution already is, since that's the very address it's about to
    // resume from.
    function breakpointsForGo() {
      const pc = $('reg-P').textContent;
      return breakpoints.map(bp => (bp && bp !== pc) ? bp : null);
    }

    $('btn-step').addEventListener('click', () => {
      setStepButtonsEnabled(false);
      vscode.postMessage({ command: 'step' });
    });
    $('btn-go').addEventListener('click', () => {
      setStepButtonsEnabled(false);
      const [bp1, bp2] = breakpointsForGo();
      vscode.postMessage({ command: 'go', bp1, bp2 });
    });

    // Same as Step, unless the instruction at the current PC (from the most
    // recent register-line parse) is a CALL - then it runs the call to
    // completion with a breakpoint right after it, instead of stepping into
    // the callee one instruction at a time. That breakpoint borrows slot 0
    // (bp1) for the duration of the run - swapping the user's own
    // breakpoint 1 out (saved in savedBreakpoint1) if one was set - since
    // the 'go' message always sends whatever's currently in `breakpoints`;
    // it's put back once the 'ready' handler below sees the run finish.
    $('btn-step-over').addEventListener('click', () => {
      setStepButtonsEnabled(false);
      const disasm = $('reg-disasm').textContent;
      const pc = $('reg-P').textContent;
      if (isCallInstruction(disasm)) {
        const stepOverTarget = addressAfterCall(pc);
        if (stepOverTarget) {
          savedBreakpoint1 = breakpoints[0];
          stepOverPending = true;
          breakpoints[0] = stepOverTarget;
          updateBreakpointDisplay();
          const [bp1, bp2] = breakpointsForGo();
          vscode.postMessage({ command: 'go', bp1, bp2 });
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
        buildListingRows();
        updateListingDisplay($('reg-P').textContent);
      } else if (msg.command === 'ready') {
        if (stepOverPending) {
          breakpoints[0] = savedBreakpoint1;
          savedBreakpoint1 = null;
          stepOverPending = false;
          updateBreakpointDisplay();
        }
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
