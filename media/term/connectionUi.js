import { $ } from './dom.js';

let isConnected = false;
let isBusy = false;
let connectedPort = '';

export function getIsConnected() { return isConnected; }
export function getIsBusy() { return isBusy; }

export function updateRemoteCcpDisableBtn(disabled) {
  const btn = $('remotccp-disable-btn');
  btn.textContent = disabled ? 'Enable REMOTCCP' : 'Disable REMOTCCP';
  btn.classList.toggle('active', disabled);
}

export function appendActivity(text) {
  const log = $('activity-log');
  const time = new Date().toLocaleTimeString([], { hour12: false });
  const entry = document.createElement('div');
  entry.textContent = '[' + time + '] ' + text;
  log.appendChild(entry);
  while (log.children.length > 50) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

export function renderState() {
  const status = $('status');
  const dot = $('ready-dot');
  const readyText = $('ready-text');
  $('reset-btn').disabled = !(isConnected || isBusy);
  $('busy-overlay').hidden = !(isConnected && isBusy);
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

export function setConnected(connected, port) {
  isConnected = connected;
  connectedPort = port;
  $('connect-btn').disabled = connected;
  $('disconnect-btn').disabled = !connected;
  renderState();
  if (connected) $('output').focus();
}

export function setBusy(busy) {
  isBusy = busy;
  renderState();
}
