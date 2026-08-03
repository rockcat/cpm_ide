import { $ } from './dom.js';
import { EMULATIONS } from './emulation/index.js';

export const BAUD_RATES = [300, 1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];
export const DATA_BITS = [5, 6, 7, 8];
export const STOP_BITS = [1, 2];
export const PARITIES = ['none', 'even', 'odd', 'mark', 'space'];
export const FLOW_CONTROLS = [
  { value: 'none', label: 'None' },
  { value: 'xonxoff', label: 'Xon/Xoff' },
  { value: 'rtscts', label: 'RTS/CTS' },
];
export const TERMINAL_SIZES = ['80x25', '64x16', '40x24', '52x24'];
export const DEVICE_TYPES = ['Generic', 'microBeast', 'z80 MBC', 'PicoCP/M2.2'];

export const TRANSFER_APPS = ['REMOTCCP.COM', 'SLIDECPM.COM','XMODEM.COM'];

export function populateSelect(id, values, currentValue, labelFor) {
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

// Shows/hides the secondary, device-specific toolbar row based on the
// selected device type. Each device's controls live in their own
// [data-device] group, hidden unless it matches the current selection; the
// whole row hides itself when no group is visible (e.g. Generic).
export function updateDeviceToolbar(deviceType) {
  const groups = document.querySelectorAll('#device-toolbar [data-device]');
  let anyVisible = false;
  groups.forEach(el => {
    const visible = el.dataset.device === deviceType;
    el.hidden = !visible;
    if (visible) anyVisible = true;
  });
  $('device-toolbar').hidden = !anyVisible;
}

let initialPort = '';
export function getInitialPort() { return initialPort; }

// Settings arrive from the extension host rather than being baked into the
// HTML server-side, so the dropdowns start empty until this runs.
export function applyInitialSettings(settings) {
  initialPort = settings.serialPort || '';
  populateSelect('baud', BAUD_RATES, settings.baudRate);
  populateSelect('databits', DATA_BITS, settings.dataBits);
  populateSelect('stopbits', STOP_BITS, settings.stopBits);
  populateSelect('parity', PARITIES, settings.parity);
  populateSelect('flowcontrol', FLOW_CONTROLS, settings.flowControl, f => f.label);
  populateSelect('termsize', TERMINAL_SIZES, settings.terminalSize);
  populateSelect('device-type', DEVICE_TYPES, settings.deviceType);
  populateSelect('emulation', EMULATIONS, settings.emulation);
  populateSelect('transferapplication', TRANSFER_APPS, settings.transferApplication);
  $('trace-toggle').checked = !!settings.enableSerialTrace;
  $('force-caps').checked = !!settings.forceCapitals;
  $('text-color').value = settings.textColor || '#cccccc';
  $('auto-write').checked = settings.autoWrite !== false;
  updateDeviceToolbar($('device-type').value);
}

export function wireControlListeners({ saveSetting, onTermSizeChange, onEmulationChange, onTransferApplicationChange, onTextColorChange }) {
  $('port').addEventListener('change', () => saveSetting('serialPort', $('port').value));
  $('baud').addEventListener('change', () => saveSetting('baudRate', parseInt($('baud').value)));
  $('databits').addEventListener('change', () => saveSetting('dataBits', parseInt($('databits').value)));
  $('stopbits').addEventListener('change', () => saveSetting('stopBits', parseInt($('stopbits').value)));
  $('parity').addEventListener('change', () => saveSetting('parity', $('parity').value));
  $('flowcontrol').addEventListener('change', () => saveSetting('flowControl', $('flowcontrol').value));
  $('trace-toggle').addEventListener('change', () => saveSetting('enableSerialTrace', $('trace-toggle').checked));
  $('force-caps').addEventListener('change', () => saveSetting('forceCapitals', $('force-caps').checked));
  $('text-color').addEventListener('input', () => {
    saveSetting('textColor', $('text-color').value);
    onTextColorChange($('text-color').value);
  });
  $('termsize').addEventListener('change', () => {
    saveSetting('terminalSize', $('termsize').value);
    onTermSizeChange();
  });
  $('device-type').addEventListener('change', () => {
    saveSetting('deviceType', $('device-type').value);
    updateDeviceToolbar($('device-type').value);
  });
  $('emulation').addEventListener('change', () => {
    saveSetting('emulation', $('emulation').value);
    onEmulationChange($('emulation').value);
  });
  $('transferapplication').addEventListener('change', () => {
    saveSetting('transferApplication', $('transferapplication').value);
    onTransferApplicationChange($('transferapplication').value);
  });
  $('auto-write').addEventListener('change', () => saveSetting('autoWrite', $('auto-write').checked));
}
