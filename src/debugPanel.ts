import * as vscode from 'vscode';
import * as fs from 'fs';
import { SerialTerminal } from './serialTerminal';
import { SerialTerminalPanel } from './serialTerminalPanel';
import { ListingLine } from './listingFile';

/**
 * A small webview panel showing DDT's own prompt/status output (routed here
 * by SerialTerminal.routeDdtResponse() while ddtMode is active) - the
 * debugged program's own output keeps going to the main CP/M Terminal
 * instead. See SerialTerminalPanel for the fuller pattern this is modeled
 * on; this one has no settings panel, just an output view, a register/flags
 * readout, and a listing view. There is no keystroke input - DDT_MODE has
 * no free-typing, every command is one of the Step/Step Over/Go buttons
 * (see SerialTerminal.stepDdt()/goDdt()).
 */
export class DebugPanel {
	private _panel: vscode.WebviewPanel | undefined;
	private _disposables: vscode.Disposable[] = [];
	/** Most recently loaded listing, kept even while the panel is closed so a freshly (re)created panel can be sent it immediately - see show(). */
	private latestListing: ListingLine[] = [];

	constructor(
		private readonly serialTerminal: SerialTerminal,
		private readonly serialTerminalPanel: SerialTerminalPanel,
		private readonly extensionUri: vscode.Uri
	) {
		// Self-sufficient: reveals itself the moment DDT launches, and marks
		// the session's end in-place if it's still open when DDT exits.
		serialTerminal.onDdtModeChanged((active) => {
			if (active) {
				// A panel left open from a previous session shouldn't show
				// stale registers/listing/buttons from whatever that left
				// behind - reset BEFORE show()/reveal, then resend this
				// session's listing (loadDdtListing*() already ran and
				// cached it in latestListing by the time launchDdt() gets
				// here) so reset doesn't wipe it back out again. A
				// brand-new panel gets both messages queued before its
				// script even runs, which is harmless.
				this._panel?.webview.postMessage({ command: 'reset' });
				this.show();
				this._panel?.webview.postMessage({ command: 'listing', lines: this.latestListing });
			} else {
				this._panel?.webview.postMessage({ command: 'data', text: '\r\n[DDT session ended]\r\n', sessionEnded: true });
			}
		});

		// Subscribed here (not inside show()) because loadDdtListing*() runs
		// before launchDdt() fires onDdtModeChanged - the listing is often
		// ready before the panel/webview even exists, so it's cached and
		// replayed to the webview once show() creates it.
		serialTerminal.onDdtListingChanged((lines) => {
			this.latestListing = lines ?? [];
			this._panel?.webview.postMessage({ command: 'listing', lines: this.latestListing });
		});

		// Authoritative "safe to send the next command" signal - see
		// SerialTerminal.routeDdtResponse(). Replaces guessing readiness
		// from whether the DEBUG panel happened to be able to parse a
		// register line out of the last response.
		serialTerminal.onDdtReady(() => {
			this._panel?.webview.postMessage({ command: 'ready' });
		});
	}

	/** Just to the right of the main CP/M Terminal's own column, so DDT opens as a split rather than a tab sharing its group. Falls back to the rightmost open group if the terminal isn't open yet. */
	private targetViewColumn(): vscode.ViewColumn {
		const terminalColumn = this.serialTerminalPanel.viewColumn;
		if (terminalColumn !== undefined) {
			return terminalColumn + 1;
		}
		const groups = vscode.window.tabGroups.all;
		if (groups.length === 0) {
			return vscode.ViewColumn.One;
		}
		return groups.reduce((max, g) => (g.viewColumn > max ? g.viewColumn : max), groups[0].viewColumn) + 1;
	}

	show() {
		if (this._panel) {
			this._panel.reveal(this.targetViewColumn());
			return;
		}

		const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
		const codiconsRoot = vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist');

		this._panel = vscode.window.createWebviewPanel(
			'cpmDebugPanel',
			'DDT Debug',
			this.targetViewColumn(),
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [mediaRoot, codiconsRoot]
			}
		);

		this._panel.webview.onDidReceiveMessage((msg) => {
			switch (msg.command) {
				case 'step':
					this.serialTerminal.stepDdt();
					break;
				case 'go':
					this.serialTerminal.goDdt(msg.start, msg.breakpoint);
					break;
				case 'restart':
					this.serialTerminal.restartDdt();
					break;
				case 'endSession':
					this.serialTerminal.endDdtSession();
					this._panel?.dispose();
					break;
				default:
					console.warn('[DebugPanel] Unknown message command:', msg.command);
			}
		}, null, this._disposables);

		this._panel.webview.html = this.getHtml(this._panel.webview, mediaRoot, codiconsRoot);
		this._panel.webview.postMessage({ command: 'listing', lines: this.latestListing });

		this._disposables.push(
			this.serialTerminal.onDebugData(text => {
				this._panel?.webview.postMessage({ command: 'data', text });
			})
		);

		this._panel.onDidDispose(() => {
			this._panel = undefined;
			this._disposables.forEach(d => d.dispose());
			this._disposables = [];
		});
	}

	private getHtml(webview: vscode.Webview, mediaRoot: vscode.Uri, codiconsRoot: vscode.Uri): string {
		const htmlPath = vscode.Uri.joinPath(mediaRoot, 'debug.html').fsPath;
		const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'terminal.css'));
		const debugStyleUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'debug.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'debug.js'));
		const codiconCssUri = webview.asWebviewUri(vscode.Uri.joinPath(codiconsRoot, 'codicon.css'));

		return fs.readFileSync(htmlPath, 'utf8')
			.replace(/\{\{cspSource\}\}/g, webview.cspSource)
			.replace(/\{\{styleUri\}\}/g, styleUri.toString())
			.replace(/\{\{debugStyleUri\}\}/g, debugStyleUri.toString())
			.replace(/\{\{scriptUri\}\}/g, scriptUri.toString())
			.replace(/\{\{codiconCssUri\}\}/g, codiconCssUri.toString());
	}
}
