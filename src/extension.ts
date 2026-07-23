import * as vscode from 'vscode';
import { SerialTerminal } from './serialTerminal';
import { SerialTerminalPanel } from './serialTerminalPanel';
import { CpmFileExplorer, CpmFileItem } from './fileExplorer';
import { LocalFileExplorer, LocalFileSystemItem } from './localFileExplorer';
import { BuildManager } from './build';

let serialTerminal: SerialTerminal | undefined;
let serialTerminalPanel: SerialTerminalPanel | undefined;
let cpmFileExplorer: CpmFileExplorer | undefined;
let localFileExplorer: LocalFileExplorer | undefined;
let buildManager: BuildManager | undefined;
let cpmFilesView: vscode.TreeView<unknown> | undefined;

async function confirmManualSend(fsPath: string): Promise<boolean> {
	const choice = await vscode.window.showInformationMessage(
		`Prepare CP/M first: run \"XMODEM <FILE> /R\" in the terminal (or on the device), then click Start Send. ` +
		`Sending: ${fsPath}`,
		{ modal: true },
		'Start Send'
	);
	return choice === 'Start Send';
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOP'.split('');

async function pickTargetDrive(terminal: SerialTerminal): Promise<string | undefined> {
	if (!terminal.isOpen) {
		vscode.window.showErrorMessage('Serial port not connected');
		return undefined;
	}

	// Deliberately doesn't probe the device (scanDrives()) - that scan's own
	// traffic can land on the wire right before the XMODEM handshake and
	// confuse the receiving XMODEM.COM. The user already knows which drive
	// they're targeting, so just ask.
	const picked = await vscode.window.showQuickPick(DRIVE_LETTERS.map((drive) => ({
		label: `${drive}:`,
		description: 'Target drive for upload',
		value: drive,
	})), {
		title: 'Select target CP/M drive',
		placeHolder: 'Choose destination drive for file transfer'
	});

	return picked?.value;
}

export function activate(context: vscode.ExtensionContext) {
	console.log('CP/M IDE extension is now active');

	// Initialize serial terminal backend
	serialTerminal = new SerialTerminal(context);

	// Initialize the webview panel (right-side split panel)
	serialTerminalPanel = new SerialTerminalPanel(serialTerminal, context.extensionUri);

	// Initialize file explorer
	cpmFileExplorer = new CpmFileExplorer(serialTerminal);
	cpmFilesView = vscode.window.createTreeView('cpmFilesExplorer', {
		treeDataProvider: cpmFileExplorer
	});
	updateConnectionUi(false);

	// Initialize local workspace file browser (for manual XMODEM sends)
	localFileExplorer = new LocalFileExplorer();
	const localFilesView = vscode.window.createTreeView('cpmLocalFilesExplorer', {
		treeDataProvider: localFileExplorer,
		// Slide can send multiple files in one go via ctrl/shift-click.
		canSelectMany: true
	});

	context.subscriptions.push(
		cpmFilesView,
		localFilesView
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

		vscode.commands.registerCommand('cpm-ide.assembleFile', async (item: LocalFileSystemItem) => {
			if (buildManager && item?.resourceUri) {
				if (await buildManager.assembleFile(item.resourceUri.fsPath)) {
					localFileExplorer?.refresh();
				}
			}
		}),

		vscode.commands.registerCommand('cpm-ide.compileFile', async (item: LocalFileSystemItem) => {
			if (buildManager && item?.resourceUri) {
				if (await buildManager.compileFile(item.resourceUri.fsPath)) {
					localFileExplorer?.refresh();
				}
			}
		}),

		vscode.commands.registerCommand('cpm-ide.transferLocalFileToDevice', async () => {
			if (!serialTerminal) {
				return;
			}

			const selected = await vscode.window.showOpenDialog({
				canSelectMany: false,
				openLabel: 'Send to CP/M Device',
				filters: {
					'All Files': ['*']
				}
			});

			if (!selected?.[0]) {
				return;
			}

			const targetDrive = await pickTargetDrive(serialTerminal);
			if (!targetDrive) {
				return;
			}

			if (await serialTerminal.transferFileToDevice(selected[0].fsPath, targetDrive)) {
				await cpmFileExplorer?.refreshDrive(targetDrive);
			}
		}),

		vscode.commands.registerCommand('cpm-ide.transferFileToDevice', async (fileUri: vscode.Uri) => {
			if (serialTerminal && fileUri) {
				const targetDrive = await pickTargetDrive(serialTerminal);
				if (!targetDrive) {
					return;
				}
				if (await serialTerminal.transferFileToDevice(fileUri.fsPath, targetDrive)) {
					await cpmFileExplorer?.refreshDrive(targetDrive);
				}
			}
		}),

		// Local Files tree items aren't real explorer entries, so VS Code
		// passes the tree item itself here rather than a Uri - unwrap it.
		vscode.commands.registerCommand('cpm-ide.transferFileToDeviceFromTree', async (item: LocalFileSystemItem) => {
			if (!serialTerminal || !item?.resourceUri) {
				return;
			}

			const targetDrive = await pickTargetDrive(serialTerminal);
			if (!targetDrive) {
				return;
			}

			if (await serialTerminal.transferFileToDevice(item.resourceUri.fsPath, targetDrive)) {
				await cpmFileExplorer?.refreshDrive(targetDrive);
			}
		}),

		// `selectedItems` is populated by VS Code when multiple items are
		// selected (ctrl/shift-click) at the time the context menu action
		// is invoked - falls back to the single clicked item otherwise.
		vscode.commands.registerCommand('cpm-ide.sendFilesSlide', async (item: LocalFileSystemItem, selectedItems?: LocalFileSystemItem[]) => {
			if (!serialTerminal) {
				return;
			}

			const items = (selectedItems && selectedItems.length > 0) ? selectedItems : (item ? [item] : []);
			const filePaths = items
				.filter((i) => i?.resourceUri && !i.isDirectory)
				.map((i) => i.resourceUri!.fsPath);

			if (filePaths.length === 0) {
				return;
			}

			const targetDrive = await pickTargetDrive(serialTerminal);
			if (!targetDrive) {
				return;
			}

			if (await serialTerminal.sendFilesViaSlide(filePaths, targetDrive)) {
				await cpmFileExplorer?.refreshDrive(targetDrive);
			}
		}),

		vscode.commands.registerCommand('cpm-ide.transferFileFromDevice', async (fileItem: CpmFileItem) => {
			if (serialTerminal && fileItem) {
				if (await serialTerminal.transferFileFromDevice(fileItem.fileName, fileItem.drive)) {
					localFileExplorer?.refresh();
				}
			}
		}),

		vscode.commands.registerCommand('cpm-ide.receiveXmodemManual', async () => {
			if (!serialTerminal?.isOpen) {
				vscode.window.showErrorMessage('Serial port not connected');
				return;
			}

			const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
			const defaultUri = workspaceFolder
				? vscode.Uri.file(`${workspaceFolder.uri.fsPath}\\xmodem-download.bin`)
				: undefined;

			const destination = await vscode.window.showSaveDialog({
				title: 'Receive XMODEM File (Manual)',
				saveLabel: 'Start Receive',
				defaultUri
			});

			if (!destination) {
				return;
			}

			const startChoice = await vscode.window.showInformationMessage(
				`Prepare CP/M first: run \"XMODEM <FILE> /S\" in the terminal (or on the device), then click Start Receive. ` +
				`Destination: ${destination.fsPath}`,
				{ modal: true },
				'Start Receive'
			);

			if (startChoice !== 'Start Receive') {
				return;
			}

			if (await serialTerminal.receiveFileManualXmodem(destination.fsPath)) {
				localFileExplorer?.refresh();
			}
		}),

		vscode.commands.registerCommand('cpm-ide.sendXmodemManual', async () => {
			if (!serialTerminal?.isOpen) {
				vscode.window.showErrorMessage('Serial port not connected');
				return;
			}

			const selected = await vscode.window.showOpenDialog({
				canSelectMany: false,
				openLabel: 'Send (Manual XMODEM)',
				filters: {
					'All Files': ['*']
				}
			});

			if (!selected?.[0]) {
				return;
			}

			if (!await confirmManualSend(selected[0].fsPath)) {
				return;
			}

			await serialTerminal.sendFileManualXmodem(selected[0].fsPath);
		}),

		vscode.commands.registerCommand('cpm-ide.sendXmodemManualFromTree', async (item: LocalFileSystemItem) => {
			if (!serialTerminal?.isOpen || !item?.resourceUri) {
				return;
			}

			if (!await confirmManualSend(item.resourceUri.fsPath)) {
				return;
			}

			await serialTerminal.sendFileManualXmodem(item.resourceUri.fsPath);
		}),

		vscode.commands.registerCommand('cpm-ide.refreshLocalFileExplorer', () => {
			localFileExplorer?.refresh();
		}),

		vscode.commands.registerCommand('cpm-ide.refreshFileExplorer', () => {
			if (!serialTerminal?.isOpen) {
				return;
			}
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
			updateConnectionUi(true, serialTerminal?.currentPort);
			cpmFileExplorer?.refresh();
		})
	);

	context.subscriptions.push(
		serialTerminal.onDisconnect(() => {
			updateConnectionUi(false);
			cpmFileExplorer?.clear();
		})
	);

	// The CP/M version isn't known at connect time - it's learned lazily,
	// from the startup byte of whichever Remote CCP session happens to
	// launch first (e.g. during the post-connect refresh) - so the status
	// line needs a separate refresh once it shows up.
	context.subscriptions.push(
		serialTerminal.onCpmVersionDetected(() => {
			if (serialTerminal?.isOpen) {
				updateConnectionUi(true, serialTerminal.currentPort);
			}
		})
	);

	// "Assemble"/"Compile" only show up once a tool is actually configured -
	// re-evaluate whenever settings change, not just at startup.
	updateBuildToolUi();
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('cpmIde.assembler') || e.affectsConfiguration('cpmIde.compiler')) {
				updateBuildToolUi();
			}
		})
	);

	// Auto-connect on startup if configured
	const settings = vscode.workspace.getConfiguration('cpmIde');
	if (settings.get('autoConnect')) {
		serialTerminalPanel?.show();
		serialTerminal?.connect();
	}
}

function updateBuildToolUi() {
	const settings = vscode.workspace.getConfiguration('cpmIde');
	void vscode.commands.executeCommand('setContext', 'cpmIde.assemblerConfigured', !!settings.get<string>('assembler'));
	void vscode.commands.executeCommand('setContext', 'cpmIde.compilerConfigured', !!settings.get<string>('compiler'));
}

function updateConnectionUi(connected: boolean, portName?: string) {
	void vscode.commands.executeCommand('setContext', 'cpmIde.connected', connected);

	if (!cpmFilesView) {
		return;
	}

	if (!connected) {
		cpmFilesView.message = 'Status: Disconnected';
		return;
	}

	const version = serialTerminal?.detectedCpmVersion;
	cpmFilesView.message =
		`Status: Connected${portName ? ` (${portName})` : ''}` +
		(version ? `    ${version}` : '');
}

export function deactivate() {
	if (serialTerminal) {
		serialTerminal.dispose();
	}
}
