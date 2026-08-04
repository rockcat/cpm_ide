import * as vscode from 'vscode';
import * as fs from 'fs';
import SerialPort from 'serialport';
import { SerialTerminal } from './serialTerminal';

/**
 * Orders port paths the way a person would expect rather than plain string
 * order, where "COM10" sorts before "COM2" - splits each into alternating
 * digit/non-digit runs and compares numeric runs by value.
 */
function comparePortPaths(a: string, b: string): number {
	const aParts = a.match(/\d+|\D+/g) ?? [a];
	const bParts = b.match(/\d+|\D+/g) ?? [b];
	const len = Math.max(aParts.length, bParts.length);
	for (let i = 0; i < len; i++) {
		const aPart = aParts[i] ?? '';
		const bPart = bParts[i] ?? '';
		if (aPart === bPart) {
			continue;
		}
		if (/^\d+$/.test(aPart) && /^\d+$/.test(bPart)) {
			const diff = Number(aPart) - Number(bPart);
			if (diff !== 0) {
				return diff;
			}
		} else {
			const cmp = aPart.localeCompare(bPart);
			if (cmp !== 0) {
				return cmp;
			}
		}
	}
	return 0;
}

export class SerialTerminalPanel {
	private _panel: vscode.WebviewPanel | undefined;
	private _disposables: vscode.Disposable[] = [];

	constructor(
		private readonly serialTerminal: SerialTerminal,
		private readonly extensionUri: vscode.Uri
	) {}

	/** This panel's current column, if it's open - lets DebugPanel position itself just to the right of it. */
	get viewColumn(): vscode.ViewColumn | undefined {
		return this._panel?.viewColumn;
	}

	/**
	 * Reveals this panel and moves keyboard focus into its terminal output
	 * area - used when a DDT Step Over/Go actually runs the debugged program
	 * rather than single-stepping it, since that program may do its own
	 * console I/O (e.g. a "press any key" prompt) the moment it starts
	 * running, and the DEBUG panel itself has nothing to type into (see its
	 * class comment - DDT_MODE has no free-typing). No-op if the terminal
	 * isn't open - DDT can't be running without a connection, and this
	 * panel is how that connection was made, but it doesn't force the
	 * terminal back open if the user closed it since.
	 */
	focusTerminalInput(): void {
		if (!this._panel) {
			return;
		}
		this._panel.reveal();
		this._panel.webview.postMessage({ command: 'focusTerminal' });
	}

	/** The rightmost currently-open editor group, so the terminal joins it as a tab instead of always splitting open a new column. */
	private rightmostViewColumn(): vscode.ViewColumn {
		const groups = vscode.window.tabGroups.all;
		if (groups.length === 0) {
			return vscode.ViewColumn.One;
		}
		return groups.reduce((max, g) => (g.viewColumn > max ? g.viewColumn : max), groups[0].viewColumn);
	}

	show() {
		if (this._panel) {
			this._panel.reveal(this.rightmostViewColumn());
			return;
		}

		const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');

		this._panel = vscode.window.createWebviewPanel(
			'cpmSerialTerminal',
			'CP/M Terminal',
			this.rightmostViewColumn(),
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [mediaRoot]
			}
		);

		// Set up message handler BEFORE setting HTML to catch initial messages
		this._panel.webview.onDidReceiveMessage(async (msg) => {
			console.log('[SerialTerminalPanel] Received message:', msg.command);
			switch (msg.command) {
				case 'connect':
					try {
						await this.serialTerminal.connect(
							msg.port, msg.baudRate, msg.dataBits, msg.stopBits, msg.parity, msg.flowControl
						);
					} catch (err) {
						this._panel?.webview.postMessage({ command: 'error', text: String(err) });
						vscode.window.showErrorMessage(`Failed to connect: ${err}`);
					}
					break;
				case 'disconnect':
					this.serialTerminal.disconnect();
					break;
				case 'resetConnection':
					try {
						await this.serialTerminal.resetConnection();
					} catch (err) {
						this._panel?.webview.postMessage({ command: 'error', text: String(err) });
						vscode.window.showErrorMessage(`Failed to reset serial connection: ${err}`);
					}
					break;
				case 'sendData':
					this.serialTerminal.sendData(msg.data);
					break;
				case 'listPorts': {
					try {
						const ports = await SerialPort.list();
						this._panel?.webview.postMessage({
							command: 'portList',
							ports: ports.map((p: any) => p.path).sort(comparePortPaths),
						});
					} catch (err) {
						console.error('Failed to list ports:', err);
						this._panel?.webview.postMessage({ command: 'portList', ports: [] });
					}
					break;
				}
				case 'updateSetting': {
					const allowedKeys = [
						'serialPort', 'baudRate', 'dataBits', 'stopBits', 'parity',
						'flowControl', 'enableSerialTrace', 'forceCapitals', 'terminalSize', 'textColor',
						'deviceType', 'autoWrite', 'emulation', 'fontFamily'
					];
					if (allowedKeys.includes(msg.key)) {
						await vscode.workspace.getConfiguration('cpmIde')
							.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
					}
					break;
				}
				case 'sendRemoteCcp': {
					// First, try installing via whatever install path matches
					// the currently selected transfer application (see
					// sendRemoteCcpViaSelectedTransferApplication) - only fall
					// back to the manual PIP-command dialog if that doesn't
					// apply or doesn't succeed.
					let installed = false;
					try {
						installed = await this.serialTerminal.sendRemoteCcpViaSelectedTransferApplication();
					} catch (err) {
						vscode.window.showErrorMessage(`Remote CCP install via the selected transfer application failed: ${err}`);
					}
					if (installed) {
						vscode.window.showInformationMessage('Remote CCP installed.');
						break;
					}

					const choice = await vscode.window.showWarningMessage(
						'Manually drive the Remote CCP (REMOTCCP.COM) install handshake. Use this to retry ' +
						'after a declined/failed auto-install, or to step through it by hand.',
						{ modal: true },
						'Send PIP command',
						'SEND RemotCCP'
					);
					try {
						if (choice === 'Send PIP command') {
							await this.serialTerminal.sendRemoteCcpPipCommand();
						} else if (choice === 'SEND RemotCCP') {
							await this.serialTerminal.sendRemoteCcpRaw();
						}
					} catch (err) {
						vscode.window.showErrorMessage(`Remote CCP send failed: ${err}`);
					}
					break;
				}
				case 'setTransferApplication':
					await vscode.workspace.getConfiguration('cpmIde')
						.update('transferApplication', msg.value, vscode.ConfigurationTarget.Global);
					break;
				case 'ready':
					// The webview's own module script (terminal.js) posts this as
					// soon as it's loaded and has registered its message
					// listener - only from this point on can it actually receive
					// anything sent to it. Sending 'connected'/'init' right after
					// `webview.html = ...` below instead (as this used to) races
					// the webview's script fetch/parse/import-graph-resolution:
					// postMessage doesn't queue for a receiver that isn't
					// listening yet, so on a slow load - a cold cache, or a busy
					// machine - those messages could be dropped entirely, which
					// is what left the dropdowns unpopulated (they're only
					// filled in once 'init' arrives). Waiting for this handshake
					// instead guarantees delivery regardless of how long the
					// webview takes to become ready.
					if (this.serialTerminal.isOpen && this.serialTerminal.currentPort) {
						this._panel?.webview.postMessage({
							command: 'connected',
							port: this.serialTerminal.currentPort,
						});
					}
					this._panel?.webview.postMessage({
						command: 'init',
						settings: this.getCurrentSettings(),
					});
					break;
				default:
					console.warn('Unknown message command:', msg.command);
			}
		}, null, this._disposables);

		this._panel.webview.html = this.getHtml(this._panel.webview, mediaRoot);

		this._disposables.push(
			this.serialTerminal.onData(text => {
				this._panel?.webview.postMessage({ command: 'data', text });
			}),
			this.serialTerminal.onConnect(port => {
				this._panel?.webview.postMessage({ command: 'connected', port });
			}),
			this.serialTerminal.onDisconnect(() => {
				this._panel?.webview.postMessage({ command: 'disconnected' });
			}),
			this.serialTerminal.onError(text => {
				this._panel?.webview.postMessage({ command: 'error', text });
			}),
			this.serialTerminal.onBusyChange(busy => {
				this._panel?.webview.postMessage({ command: 'busy', busy });
			}),
			this.serialTerminal.onActivity(text => {
				this._panel?.webview.postMessage({ command: 'activity', text });
			})
		);

		this._panel.onDidDispose(() => {
			this._panel = undefined;
			this._disposables.forEach(d => d.dispose());
			this._disposables = [];
		});
	}

	focus() {
		this.show();
	}

	private getCurrentSettings() {
		const settings = vscode.workspace.getConfiguration('cpmIde');
		return {
			serialPort: settings.get<string>('serialPort') ?? '',
			baudRate: settings.get<number>('baudRate') ?? 9600,
			dataBits: settings.get<number>('dataBits') ?? 8,
			stopBits: settings.get<number>('stopBits') ?? 1,
			parity: settings.get<string>('parity') ?? 'none',
			flowControl: settings.get<string>('flowControl') ?? 'none',
			enableSerialTrace: settings.get<boolean>('enableSerialTrace') ?? false,
			forceCapitals: settings.get<boolean>('forceCapitals') ?? true,
			terminalSize: settings.get<string>('terminalSize') ?? '80x25',
			textColor: settings.get<string>('textColor') ?? '#cccccc',
			deviceType: settings.get<string>('deviceType') ?? 'Generic',
			autoWrite: settings.get<boolean>('autoWrite') ?? true,
			emulation: settings.get<string>('emulation') ?? 'Vt52',
			fontFamily: settings.get<string>('fontFamily') ?? '',
			transferApplication: settings.get<string>('transferApplication') ?? 'REMOTCCP.COM',
		};
	}

	private getHtml(webview: vscode.Webview, mediaRoot: vscode.Uri): string {
		const htmlPath = vscode.Uri.joinPath(mediaRoot, 'terminal.html').fsPath;
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'terminal.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'terminal.js'));

		return fs.readFileSync(htmlPath, 'utf8')
			.replace(/\{\{cspSource\}\}/g, webview.cspSource)
			.replace(/\{\{styleUri\}\}/g, styleUri.toString())
			.replace(/\{\{scriptUri\}\}/g, scriptUri.toString());
	}
}
