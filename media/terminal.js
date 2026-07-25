(function () {
  'use strict';
  try {
    const vscode = acquireVsCodeApi();
    console.log('[Webview] Initialized, vscode API available');

    function $(id) { return document.getElementById(id); }

    function saveSetting(key, value) {
      vscode.postMessage({ command: 'updateSetting', key, value });
    }

    const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
    const DATA_BITS = [5, 6, 7, 8];
    const STOP_BITS = [1, 2];
    const PARITIES = ['none', 'even', 'odd', 'mark', 'space'];
    const FLOW_CONTROLS = [
      { value: 'none', label: 'None' },
      { value: 'xonxoff', label: 'Xon/Xoff' },
      { value: 'rtscts', label: 'RTS/CTS' },
    ];
    const TERMINAL_SIZES = ['80x25', '64x16', '40x24', '52x24'];

    function populateSelect(id, values, currentValue, labelFor) {
      const sel = $(id);
      sel.innerHTML = '';
      values.forEach(v => {
        const value = typeof v === 'object' ? v.value : String(v);
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = labelFor ? labelFor(v) : value;
        if (value === String(currentValue)) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    let initialPort = '';

    function updateRemoteCcpDisableBtn(disabled) {
      const btn = $('remotccp-disable-btn');
      btn.textContent = disabled ? 'Enable REMOTCCP' : 'Disable REMOTCCP';
      btn.classList.toggle('active', disabled);
    }

    // Settings arrive from the extension host rather than being baked into
    // the HTML server-side, so the dropdowns start empty until this runs.
    function applyInitialSettings(settings) {
      initialPort = settings.serialPort || '';
      populateSelect('baud', BAUD_RATES, settings.baudRate);
      populateSelect('databits', DATA_BITS, settings.dataBits);
      populateSelect('stopbits', STOP_BITS, settings.stopBits);
      populateSelect('parity', PARITIES, settings.parity);
      populateSelect('flowcontrol', FLOW_CONTROLS, settings.flowControl, f => f.label);
      populateSelect('termsize', TERMINAL_SIZES, settings.terminalSize);
      $('trace-toggle').checked = !!settings.enableSerialTrace;
      $('force-caps').checked = !!settings.forceCapitals;
      $('text-color').value = settings.textColor || '#cccccc';
      applyTextColor();
      resizeGrid();
      applyTerminalSize();
    }

    function applyTextColor() {
      $('output').style.color = $('text-color').value;
    }

    $('port').addEventListener('change', () => saveSetting('serialPort', $('port').value));
    $('baud').addEventListener('change', () => saveSetting('baudRate', parseInt($('baud').value)));
    $('databits').addEventListener('change', () => saveSetting('dataBits', parseInt($('databits').value)));
    $('stopbits').addEventListener('change', () => saveSetting('stopBits', parseInt($('stopbits').value)));
    $('parity').addEventListener('change', () => saveSetting('parity', $('parity').value));
    $('flowcontrol').addEventListener('change', () => saveSetting('flowControl', $('flowcontrol').value));
    $('trace-toggle').addEventListener('change', () => saveSetting('enableSerialTrace', $('trace-toggle').checked));
    $('force-caps').addEventListener('change', () => saveSetting('forceCapitals', $('force-caps').checked));
    $('text-color').addEventListener('input', () => {
      applyTextColor();
      saveSetting('textColor', $('text-color').value);
    });
    $('termsize').addEventListener('change', () => {
      saveSetting('terminalSize', $('termsize').value);
      resizeGrid();
      applyTerminalSize();
    });

    // Scales the terminal's font size so the chosen COLSxROWS character grid
    // fits the panel's currently available space, without overflowing
    // either dimension. No-ops until the term-size dropdown has a value
    // (i.e. before applyInitialSettings() has run).
    function applyTerminalSize() {
      const raw = $('termsize').value;
      if (!raw) return;
      const [cols, rows] = raw.split('x').map(Number);
      const out = $('output');
      const style = getComputedStyle(out);
      const lineHeightRatio = 1.4;

      const measurer = document.createElement('span');
      measurer.style.position = 'absolute';
      measurer.style.visibility = 'hidden';
      measurer.style.whiteSpace = 'pre';
      measurer.style.fontFamily = style.fontFamily;
      measurer.style.fontSize = '100px';
      measurer.textContent = '0'.repeat(cols);
      document.body.appendChild(measurer);
      const charWidthPerPx = measurer.getBoundingClientRect().width / cols / 100;
      document.body.removeChild(measurer);

      const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      const paddingY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const availWidth = out.clientWidth - paddingX;
      const availHeight = out.clientHeight - paddingY;

      const fontSizeForWidth = availWidth / (cols * charWidthPerPx);
      const fontSizeForHeight = availHeight / (rows * lineHeightRatio);
      const fontSize = Math.max(6, Math.floor(Math.min(fontSizeForWidth, fontSizeForHeight)));

      out.style.fontSize = fontSize + 'px';
      out.style.lineHeight = String(lineHeightRatio);
    }

    // ---- VT52 terminal emulation ----
    // A bounded character grid + cursor, matching how CP/M full-screen
    // programs (WordStar, ZDE, etc.) actually address the screen via cursor
    // escape sequences - not a scrolling text log. Standard DEC VT52
    // control codes are interpreted; unrecognized ones are silently
    // consumed rather than rendered as garbage.
    let termCols = 80, termRows = 25;
    let screen = [];
    let cursorRow = 0, cursorCol = 0;
    let vt52State = 'NORMAL';
    let escYRow = 0;
    let graphicsMode = false;

    // Lines pushed off the top of the live grid, kept around so the user can
    // scroll back through recent output instead of losing it. Capped so the
    // DOM doesn't grow without bound over a long session.
    const MAX_SCROLLBACK = 2000;
    let scrollback = [];
    // True once the user has scrolled away from the bottom to read history -
    // suppresses the auto-scroll-to-bottom on new output until they either
    // scroll back down themselves or start typing again.
    let userScrolledUp = false;

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

    function initScreen(cols, rows) {
      termCols = cols;
      termRows = rows;
      screen = [];
      for (let r = 0; r < rows; r++) screen.push(new Array(cols).fill(' '));
      cursorRow = 0;
      cursorCol = 0;
      vt52State = 'NORMAL';
      graphicsMode = false;
    }

    // No-ops until the term-size dropdown has a value.
    function resizeGrid() {
      const raw = $('termsize').value;
      if (!raw) return;
      const [cols, rows] = raw.split('x').map(Number);
      initScreen(cols, rows);
      renderScreen();
    }

    function clearScreen() {
      scrollback = [];
      initScreen(termCols, termRows);
      renderScreen();
    }

    function scrollUp() {
      const departingRow = screen.shift();
      const line = departingRow.map(escapeHtml).join('').replace(/\s+$/, '');
      scrollback.push(line);
      if (scrollback.length > MAX_SCROLLBACK) scrollback.shift();
      screen.push(new Array(termCols).fill(' '));
    }

    function scrollDown() {
      screen.pop();
      screen.unshift(new Array(termCols).fill(' '));
    }

    function eraseToEndOfLine() {
      for (let c = cursorCol; c < termCols; c++) screen[cursorRow][c] = ' ';
    }

    function eraseToEndOfScreen() {
      eraseToEndOfLine();
      for (let r = cursorRow + 1; r < termRows; r++) screen[r] = new Array(termCols).fill(' ');
    }

    function putChar(ch) {
      if (cursorCol >= termCols) {
        cursorCol = 0;
        cursorRow++;
        if (cursorRow >= termRows) { scrollUp(); cursorRow = termRows - 1; }
      }
      screen[cursorRow][cursorCol] = ch;
      cursorCol++;
    }

    function flashBell() {
      const out = $('output');
      out.classList.add('flash');
      setTimeout(() => out.classList.remove('flash'), 100);
    }

    function escapeHtml(ch) {
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      if (ch === '&') return '&amp;';
      return ch;
    }

    function renderScreen() {
      const out = $('output');
      let html = '';
      for (const line of scrollback) {
        html += line + '\n';
      }
      for (let r = 0; r < termRows; r++) {
        for (let c = 0; c < termCols; c++) {
          const ch = escapeHtml(screen[r][c]);
          html += (r === cursorRow && c === cursorCol) ? '<span class="term-cursor">' + ch + '</span>' : ch;
        }
        if (r < termRows - 1) html += '\n';
      }
      out.innerHTML = html;
      if (!userScrolledUp) {
        out.scrollTop = out.scrollHeight;
      }
    }

    function processVT52(text) {
      for (const ch of text) {
        const code = ch.charCodeAt(0);

        if (vt52State === 'ESCAPE_Y_ROW') {
          escYRow = Math.max(0, Math.min(termRows - 1, code - 32));
          vt52State = 'ESCAPE_Y_COL';
          continue;
        }
        if (vt52State === 'ESCAPE_Y_COL') {
          cursorRow = escYRow;
          cursorCol = Math.max(0, Math.min(termCols - 1, code - 32));
          vt52State = 'NORMAL';
          continue;
        }
        if (vt52State === 'ESCAPE') {
          vt52State = 'NORMAL';
          switch (ch) {
            case 'A': cursorRow = Math.max(0, cursorRow - 1); break;
            case 'B': cursorRow = Math.min(termRows - 1, cursorRow + 1); break;
            case 'C': cursorCol = Math.min(termCols - 1, cursorCol + 1); break;
            case 'D': cursorCol = Math.max(0, cursorCol - 1); break;
            case 'H': cursorRow = 0; cursorCol = 0; break;
            case 'I': if (cursorRow === 0) scrollDown(); else cursorRow--; break;
            case 'J': eraseToEndOfScreen(); break;
            case 'K': eraseToEndOfLine(); break;
            case 'Y': vt52State = 'ESCAPE_Y_ROW'; break;
            case 'Z': vscode.postMessage({ command: 'sendData', data: '\x1B/Z' }); break;
            case 'F': graphicsMode = true; break;
            case 'G': graphicsMode = false; break;
            default: break; // ESC = / > / < (keypad/ANSI mode) etc: no visual effect
          }
          continue;
        }

        if (code === 0x1B) { vt52State = 'ESCAPE'; continue; }
        if (code === 0x08) { cursorCol = Math.max(0, cursorCol - 1); continue; }
        if (code === 0x09) { cursorCol = Math.min(termCols - 1, (Math.floor(cursorCol / 8) + 1) * 8); continue; }
        if (code === 0x0A) {
          cursorRow++;
          if (cursorRow >= termRows) { scrollUp(); cursorRow = termRows - 1; }
          continue;
        }
        if (code === 0x0D) { cursorCol = 0; continue; }
        if (code === 0x07) { flashBell(); continue; }
        if (code < 0x20) { continue; }

        putChar(graphicsMode ? (GRAPHICS_MAP[ch] || ch) : ch);
      }
      renderScreen();
    }

    // Safe default until applyInitialSettings() sets the real chosen size.
    initScreen(80, 25);

    // Fires once immediately with the current size, then again on every
    // resize (panel drag, sidebar toggle, etc.).
    new ResizeObserver(() => applyTerminalSize()).observe($('output'));

    console.log('[Webview] Sending listPorts message');
    vscode.postMessage({ command: 'listPorts' });

    $('refresh-btn').addEventListener('click', () => {
      console.log('[Webview] Refresh button clicked, sending listPorts');
      vscode.postMessage({ command: 'listPorts' });
    });

    $('connect-btn').addEventListener('click', () => {
      console.log('[Webview] Connect button clicked');
      const port = $('port').value;
      if (!port) {
        appendActivity('No serial port selected');
        return;
      }
      $('connect-btn').disabled = true;
      const baudRate = parseInt($('baud').value);
      const dataBits = parseInt($('databits').value);
      const stopBits = parseInt($('stopbits').value);
      const parity = $('parity').value;
      const flowControl = $('flowcontrol').value;
      console.log('[Webview] Sending connect with port:', port);
      vscode.postMessage({ command: 'connect', port, baudRate, dataBits, stopBits, parity, flowControl });
    });

    $('disconnect-btn').addEventListener('click', () => vscode.postMessage({ command: 'disconnect' }));

    $('reset-btn').addEventListener('click', () => {
      $('reset-btn').disabled = true;
      vscode.postMessage({ command: 'resetConnection' });
    });

    $('clear-btn').addEventListener('click', () => clearScreen());

    let remoteCcpDisabled = false;
    $('remotccp-disable-btn').addEventListener('click', () => {
      remoteCcpDisabled = !remoteCcpDisabled;
      updateRemoteCcpDisableBtn(remoteCcpDisabled);
      vscode.postMessage({ command: 'setRemoteCcpDisabled', value: remoteCcpDisabled });
    });

    $('remotccp-send-btn').addEventListener('click', () => {
      vscode.postMessage({ command: 'sendRemoteCcp' });
    });

    let isConnected = false;
    let isBusy = false;
    let connectedPort = '';

    // Tracks whether the user has scrolled up to read history, so new
    // output doesn't yank them back down mid-read.
    $('output').addEventListener('scroll', () => {
      const out = $('output');
      userScrolledUp = out.scrollHeight - out.scrollTop - out.clientHeight > 4;
    });

    // Typing happens directly in the terminal output, like a real serial
    // terminal - keystrokes go straight to the device, which echoes them
    // back over the serial line (no local echo here).
    $('output').addEventListener('keydown', e => {
      if (!isConnected || isBusy) return;
      if (userScrolledUp) {
        // The user was reading scrollback - typing means they're back to
        // actively using the terminal, so snap to the live view first.
        const out = $('output');
        out.scrollTop = out.scrollHeight;
        userScrolledUp = false;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        // Bare CR, matching CP/M console input - a trailing LF is never
        // consumed by the command-line reader and can be misread as a
        // pending keypress by commands (e.g. DIR) that check for one.
        vscode.postMessage({ command: 'sendData', data: '\r' });
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        vscode.postMessage({ command: 'sendData', data: '\b' });
      } else if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'v') {
        // Ctrl+Shift+V pastes clipboard text into the terminal - plain
        // Ctrl+V is deliberately left alone (falls into the Ctrl+letter
        // branch below) so it reaches CP/M programs that use it themselves
        // (e.g. WordStar's insert toggle). #output isn't contenteditable,
        // so there's no native paste target to rely on here - the Async
        // Clipboard API reads the text directly instead.
        e.preventDefault();
        sendPastedText();
      } else if (e.ctrlKey && !e.metaKey && !e.altKey && /^[a-zA-Z]$/.test(e.key)) {
        // Ctrl+letter sends the corresponding ASCII control code (Ctrl+C ->
        // 0x03/ETX, etc.), like a real terminal - except Ctrl+C with an
        // active selection, where copying the selected text is more useful
        // than sending a break.
        if (e.key.toLowerCase() === 'c' && window.getSelection().toString().length > 0) {
          return;
        }
        e.preventDefault();
        const code = e.key.toUpperCase().charCodeAt(0) - 64;
        vscode.postMessage({ command: 'sendData', data: String.fromCharCode(code) });
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const data = $('force-caps').checked ? e.key.toUpperCase() : e.key;
        vscode.postMessage({ command: 'sendData', data });
      }
    });

    // Reads the clipboard and sends its text to the device, as if typed.
    // Used by Ctrl+Shift+V (see keydown handler above).
    function sendPastedText() {
      navigator.clipboard.readText().then(text => {
        if (!text) return;
        if (userScrolledUp) {
          const out = $('output');
          out.scrollTop = out.scrollHeight;
          userScrolledUp = false;
        }
        // Bare CR line endings, matching Enter's own handling above -
        // CP/M's command-line reader only looks for CR, not LF.
        const normalized = text.replace(/\r\n|\r|\n/g, '\r');
        const data = $('force-caps').checked ? normalized.toUpperCase() : normalized;
        vscode.postMessage({ command: 'sendData', data });
      }).catch(err => {
        console.error('[Webview] Clipboard read failed:', err);
        appendActivity('Paste failed: could not read clipboard');
      });
    }

    $('output').addEventListener('click', () => { if (isConnected) $('output').focus(); });

    function appendActivity(text) {
      const log = $('activity-log');
      const time = new Date().toLocaleTimeString([], { hour12: false });
      const entry = document.createElement('div');
      entry.textContent = '[' + time + '] ' + text;
      log.appendChild(entry);
      while (log.children.length > 50) log.removeChild(log.firstChild);
      log.scrollTop = log.scrollHeight;
    }

    function setConnected(connected, port) {
      isConnected = connected;
      connectedPort = port;
      $('connect-btn').disabled = connected;
      $('disconnect-btn').disabled = !connected;
      renderState();
      if (connected) {
        $('output').focus();
      }
    }

    function renderState() {
      const status = $('status');
      const dot = $('ready-dot');
      const readyText = $('ready-text');
      $('reset-btn').disabled = !(isConnected || isBusy);
      if (!isConnected) {
        status.textContent = 'Disconnected';
        status.className = 'disconnected';
        dot.className = '';
        readyText.textContent = 'Not connected';
      } else if (isBusy) {
        status.textContent = 'Busy';
        status.className = 'connected';
        dot.className = 'busy';
        readyText.textContent = 'Busy — background task running, typing is paused';
      } else {
        status.textContent = 'Connected: ' + connectedPort;
        status.className = 'connected';
        dot.className = 'ready';
        readyText.textContent = 'Ready — click the terminal and type';
      }
    }

    window.addEventListener('message', e => {
      const msg = e.data;
      switch (msg.command) {
        case 'init':
          applyInitialSettings(msg.settings);
          remoteCcpDisabled = !!msg.remoteCcpDisabled;
          updateRemoteCcpDisableBtn(remoteCcpDisabled);
          break;
        case 'portList': {
          const sel = $('port');
          const prev = sel.value || initialPort;
          sel.innerHTML = '';
          let ports = msg.ports || [];
          // The live scan can miss a port that's known to work (e.g. a
          // transient enumeration issue) - keep the saved/previous port
          // selectable instead of silently losing it and falling back to
          // an empty selection.
          if (prev && !ports.includes(prev)) {
            ports = [prev, ...ports];
          }
          if (ports.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '(no ports found)';
            sel.appendChild(opt);
          } else {
            ports.forEach(p => {
              const opt = document.createElement('option');
              opt.value = opt.textContent = p;
              if (p === prev) opt.selected = true;
              sel.appendChild(opt);
            });
          }
          break;
        }
        case 'data':
          processVT52(msg.text);
          break;
        case 'connected':
          setConnected(true, msg.port);
          break;
        case 'disconnected':
          setConnected(false, '');
          break;
        case 'busy':
          isBusy = msg.busy;
          renderState();
          break;
        case 'activity':
          appendActivity(msg.text);
          break;
        case 'error':
          processVT52('\r\n[ERROR] ' + msg.text + '\r\n');
          $('connect-btn').disabled = false;
          break;
      }
    });
  } catch (err) {
    console.error('[Webview] Fatal error:', err);
    document.body.innerHTML = '<pre style="color:red; padding:20px;">Script Error: ' + err.message + '\n\n' + err.stack + '</pre>';
  }
})();
