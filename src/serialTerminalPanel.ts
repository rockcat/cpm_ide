import * as vscode from 'vscode';
import * as fs from 'fs';
import SerialPort from 'serialport';
import { SerialTerminal } from './serialTerminal';

export class SerialTerminalPanel {
	private _panel: vscode.WebviewPanel | undefined;
	private _disposables: vscode.Disposable[] = [];

	constructor(
		private readonly serialTerminal: SerialTerminal,
		private readonly extensionUri: vscode.Uri
	) {}

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
							ports: ports.map((p: any) => p.path),
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
						'flowControl', 'enableSerialTrace', 'forceCapitals', 'terminalSize', 'textColor'
					];
					if (allowedKeys.includes(msg.key)) {
						await vscode.workspace.getConfiguration('cpmIde')
							.update(msg.key, msg.value, vscode.ConfigurationTarget.Global);
					}
					break;
				}
				case 'setRemoteCcpDisabled':
					this.serialTerminal.setRemoteCcpDisabled(!!msg.value);
					break;
				case 'sendRemoteCcp': {
					const choice = await vscode.window.showWarningMessage(
						'Manually drive the Remote CCP (REMOTCCP.COM) install handshake on A:. Use this to retry ' +
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
			}
		}, null, this._disposables);

		this._panel.webview.html = this.getHtml(this._panel.webview, mediaRoot);

		// Restore connected state if already open
		if (this.serialTerminal.isOpen && this.serialTerminal.currentPort) {
			this._panel.webview.postMessage({
				command: 'connected',
				port: this.serialTerminal.currentPort,
			});
		}

		this._panel.webview.postMessage({
			command: 'init',
			settings: this.getCurrentSettings(),
			remoteCcpDisabled: this.serialTerminal.isRemoteCcpDisabled,
		});

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
