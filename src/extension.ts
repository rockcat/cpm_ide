import * as vscode from 'vscode';
import { SerialTerminal } from './serialTerminal';
import { SerialTerminalPanel } from './serialTerminalPanel';
import { CpmFileExplorer, CpmFileItem } from './fileExplorer';
import { BuildManager } from './build';

let serialTerminal: SerialTerminal | undefined;
let serialTerminalPanel: SerialTerminalPanel | undefined;
let cpmFileExplorer: CpmFileExplorer | undefined;
let buildManager: BuildManager | undefined;

export function activate(context: vscode.ExtensionContext) {
	console.log('CP/M IDE extension is now active');

	// Initialize serial terminal backend
	serialTerminal = new SerialTerminal();

	// Initialize the webview panel (right-side split panel)
	serialTerminalPanel = new SerialTerminalPanel(serialTerminal, context.extensionUri);

	// Initialize file explorer
	cpmFileExplorer = new CpmFileExplorer(serialTerminal);
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('cpmFilesExplorer', cpmFileExplorer)
	);

	// Initialize build manager
	buildManager = new BuildManager(context);

	// Register commands
	context.subscriptions.push(
		vscode.commands.registerCommand('cpm-ide.openSerialTerminal', () => {
			serialTerminalPanel?.show();
		}),

		vscode.commands.registerCommand('cpm-ide.configureSerialPort', () => {
			serialTerminalPanel?.show();
		}),

		vscode.commands.registerCommand('cpm-ide.buildProject', () => {
			buildManager?.buildProject();
		}),

		vscode.commands.registerCommand('cpm-ide.transferFileToDevice', (fileUri: vscode.Uri) => {
			if (serialTerminal && fileUri) {
				serialTerminal.transferFileToDevice(fileUri.fsPath);
			}
		}),

		vscode.commands.registerCommand('cpm-ide.transferFileFromDevice', (fileItem: CpmFileItem) => {
			if (serialTerminal && fileItem) {
				serialTerminal.transferFileFromDevice(fileItem.fileName, fileItem.drive);
			}
		}),

		vscode.commands.registerCommand('cpm-ide.refreshFileExplorer', () => {
			cpmFileExplorer?.refresh();
		}),

		vscode.commands.registerCommand('cpm-ide.runCommsTest', async () => {
			try {
				const result = await serialTerminal!.runCommsTest();
				vscode.window.showInformationMessage(
					`Comms test complete: ${result.receivedBytes} char(s) received in ${result.elapsedMs}ms. ` +
					`See "CP/M IDE: Serial Trace" output for the full hex dump.`
				);
			} catch (err) {
				vscode.window.showErrorMessage(`Comms test failed: ${err}`);
			}
		})
	);

	// Refresh the CP/M Files panel whenever a connection is established
	context.subscriptions.push(
		serialTerminal.onConnect(() => {
			cpmFileExplorer?.refresh();
		})
	);

	// Auto-connect on startup if configured
	const settings = vscode.workspace.getConfiguration('cpmIde');
	if (settings.get('autoConnect')) {
		serialTerminalPanel?.show();
		serialTerminal?.connect();
	}
}

export function deactivate() {
	if (serialTerminal) {
		serialTerminal.dispose();
	}
}
