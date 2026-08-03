import { $ } from './term/dom.js';
import { ScreenBuffer } from './term/screenBuffer.js';
import { createEmulation } from './term/emulation/index.js';
import { applyInitialSettings, wireControlListeners, getInitialPort } from './term/controlsPanel.js';
import { initFontPicker } from './term/fontPicker.js';
import {
  appendActivity, setConnected, setBusy, updateRemoteCcpDisableBtn,
  getIsConnected, getIsBusy,
} from './term/connectionUi.js';

(function () {
  'use strict';
  try {
    const vscode = acquireVsCodeApi();
    console.log('[Webview] Initialized, vscode API available');

    function saveSetting(key, value) {
      vscode.postMessage({ command: 'updateSetting', key, value });
    }

    function sendToDevice(data) {
      vscode.postMessage({ command: 'sendData', data });
    }

    function flashBell() {
      const out = $('output');
      out.classList.add('flash');
      setTimeout(() => out.classList.remove('flash'), 100);
    }

    const screen = new ScreenBuffer();
    let emulation = createEmulation('Vt52', screen, { onBell: flashBell, sendToDevice });

    function setEmulation(name) {
      emulation = createEmulation(name, screen, { onBell: flashBell, sendToDevice });
      screen.clear();
      render();
    }

    function setTransferApplication(name) {
      vscode.postMessage({ command: 'setTransferApplication', value: name });
    }

    // Tracks whether the user has scrolled up to read history, so new output
    // doesn't yank them back down mid-read.
    let userScrolledUp = false;
    function render() {
      screen.render($('output'), !userScrolledUp);
    }

    function applyTextColor(color) {
      $('output').style.color = color || $('text-color').value;
    }

    function applyFontFamily(family) {
      $('output').style.fontFamily = family ? `"${family}"` : '';
    }

    // No-ops until the term-size dropdown has a value.
    function resizeGrid() {
      const raw = $('termsize').value;
      if (!raw) return;
      const [cols, rows] = raw.split('x').map(Number);
      screen.init(cols, rows);
      render();
    }

    function clearScreen() {
      // Reset SGR/escape-parser state too, not just the grid - otherwise
      // stale colors/bold (or a half-parsed escape sequence) survive the
      // clear and bleed into whatever's typed/received next.
      emulation.reset();
      screen.clear();
      render();
    }

    // Scales the terminal's font size so the chosen COLSxROWS character grid
    // fits the panel's currently available space, without overflowing either
    // dimension. No-ops until the term-size dropdown has a value (i.e.
    // before the 'init' message has been handled).
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

    wireControlListeners({
      saveSetting,
      onTermSizeChange: () => { resizeGrid(); applyTerminalSize(); },
      onEmulationChange: setEmulation,
      onTransferApplicationChange: setTransferApplication,
      onTextColorChange: applyTextColor,
    });

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
      clearScreen();
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

    // Tracks whether the user has scrolled up to read history, so new
    // output doesn't yank them back down mid-read.
    $('output').addEventListener('scroll', () => {
      const out = $('output');
      userScrolledUp = out.scrollHeight - out.scrollTop - out.clientHeight > 4;
    });

    const SPECIAL_KEYS = [
      'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
      'Home', 'End', 'Insert', 'Delete', 'PageUp', 'PageDown',
    ];

    // Typing happens directly in the terminal output, like a real serial
    // terminal - keystrokes go straight to the device, which echoes them
    // back over the serial line (no local echo here).
    $('output').addEventListener('keydown', e => {
      if (!getIsConnected() || getIsBusy()) return;
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
        sendToDevice('\r');
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        sendToDevice('\b');
      } else if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Raw ESC byte - universal across emulations (like Enter/Backspace
        // above), not an emulation-specific cursor-key sequence. Needed for
        // CP/M programs that use ESC-prefixed command modes (WordStar,
        // ZDE, etc.) and to let the user manually kick off an escape
        // sequence when testing ANSI/VT52 output.
        e.preventDefault();
        sendToDevice('\x1B');
      } else if (e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'v') {
        // Ctrl+Shift+V pastes clipboard text into the terminal - plain
        // Ctrl+V is deliberately left alone (falls into the Ctrl+letter
        // branch below) so it reaches CP/M programs that use it themselves
        // (e.g. WordStar's insert toggle). #output isn't contenteditable,
        // so there's no native paste target to rely on here - the Async
        // Clipboard API reads the text directly instead.
        e.preventDefault();
        sendPastedText();
      } else if (SPECIAL_KEYS.includes(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Arrow/Home/End/etc - encoding is emulation-specific (VT52 vs ANSI
        // cursor-key sequences differ); None emulation sends nothing.
        const seq = emulation.encodeKey(e.key, e);
        if (seq) {
          e.preventDefault();
          sendToDevice(seq);
        }
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
        sendToDevice(String.fromCharCode(code));
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        const data = $('force-caps').checked ? e.key.toUpperCase() : e.key;
        sendToDevice(data);
      }
    },
    true  // capture phase: keydown must fire before the browser's default action (e.g. Backspace nav) occurs
    );

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
        // Bare CR line endings, matching Enter's own handling above - CP/M's
        // command-line reader only looks for CR, not LF.
        const normalized = text.replace(/\r\n|\r|\n/g, '\r');
        const data = $('force-caps').checked ? normalized.toUpperCase() : normalized;
        sendToDevice(data);
      }).catch(err => {
        console.error('[Webview] Clipboard read failed:', err);
        appendActivity('Paste failed: could not read clipboard');
      });
    }

    $('output').addEventListener('click', () => { if (getIsConnected()) $('output').focus(); });

    window.addEventListener('message', e => {
      const msg = e.data;
      switch (msg.command) {
        case 'init':
          applyInitialSettings(msg.settings);
          setEmulation(msg.settings.emulation || 'Vt52');
          applyTextColor(msg.settings.textColor);
          applyFontFamily(msg.settings.fontFamily);
          initFontPicker({
            currentFont: msg.settings.fontFamily,
            saveSetting,
            onFontChange: applyFontFamily,
          });
          resizeGrid();
          applyTerminalSize();
          remoteCcpDisabled = !!msg.remoteCcpDisabled;
          updateRemoteCcpDisableBtn(remoteCcpDisabled);
          break;
        case 'portList': {
          const sel = $('port');
          const prev = sel.value || getInitialPort();
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
          emulation.processInput(msg.text);
          render();
          break;
        case 'connected':
          setConnected(true, msg.port);
          break;
        case 'disconnected':
          setConnected(false, '');
          break;
        case 'busy':
          setBusy(msg.busy);
          break;
        case 'activity':
          appendActivity(msg.text);
          break;
        case 'error':
          emulation.processInput('\r\n[ERROR] ' + msg.text + '\r\n');
          render();
          $('connect-btn').disabled = false;
          break;
      }
    });
  } catch (err) {
    console.error('[Webview] Fatal error:', err);
    document.body.innerHTML = '<pre style="color:red; padding:20px;">Script Error: ' + err.message + '\n\n' + err.stack + '</pre>';
  }
})();
