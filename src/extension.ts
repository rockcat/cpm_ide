import * as vscode from 'vscode';
import { SerialTerminal } from './serialTerminal';
import { SerialTerminalPanel } from './serialTerminalPanel';
import { DebugPanel } from './debugPanel';
import { CpmFileExplorer, CpmFileItem } from './fileExplorer';
import { LocalFileExplorer, LocalFileSystemItem } from './localFileExplorer';
import { BuildManager } from './build';
import { TransfersView, TransferTreeItem, TransferDecorationProvider } from './transfersView';

let serialTerminal: SerialTerminal | undefined;
let serialTerminalPanel: SerialTerminalPanel | undefined;
let debugPanel: DebugPanel | undefined;
let cpmFileExplorer: CpmFileExplorer | undefined;
let localFileExplorer: LocalFileExplorer | undefined;
let buildManager: BuildManager | undefined;
let cpmFilesView: vscode.TreeView<unknown> | undefined;

async function confirmManualSend(fsPath: string): Promise<boolean> {
	const choice = await vscode.window.showInformationMessage(
		`Prepare CP/M first: run \"XMODEM <FILE> /R /X0\" in the terminal (or on the device), then click Start Send. ` +
		`Sending: ${fsPath}`,
		{ modal: true },
		'Start Send'
	);
	return choice === 'Start Send';
}

const DRIVE_LETTERS = 'ABCDEFGHIJKLMNOP'.split('');

/**
 * Candidate drives to offer for an upload: the last scan's detected drives
 * (cpmFileExplorer's cached list - reading it here doesn't put any new
 * traffic on the wire, unlike an actual scanDrives() probe, which could
 * land right before an XMODEM handshake and confuse the receiving
 * XMODEM.COM) if there are any, else just the CCP's current drive, so a
 * connection with no scan done yet still has something to offer instead of
 * coming up empty.
 */
function candidateTargetDrives(terminal: SerialTerminal): string[] {
	const detected = cpmFileExplorer?.detectedDrives ?? [];
	if (detected.length > 0) {
		return detected;
	}
	return terminal.activeDrive ? [terminal.activeDrive] : [];
}

/**
 * Resolves the target drive for an upload, asking the user only when
 * there's genuinely more than one candidate to choose from - see
 * candidateTargetDrives(). Falls back to offering the full A-P alphabet
 * only when neither a scan nor a known current drive can narrow it down at
 * all (e.g. a fresh connection whose CCP hasn't printed a prompt yet).
 */
async function pickTargetDrive(terminal: SerialTerminal): Promise<string | undefined> {
	if (!terminal.isOpen) {
		vscode.window.showErrorMessage('Serial port not connected');
		return undefined;
	}

	const candidates = candidateTargetDrives(terminal);
	if (candidates.length === 1) {
		return candidates[0];
	}

	const options = candidates.length > 0 ? candidates : DRIVE_LETTERS;
	const picked = await vscode.window.showQuickPick(options.map((drive) => ({
		label: `${drive}:`,
		description: 'Target drive for upload',
		value: drive,
	})), {
		title: 'Select target CP/M drive',
		placeHolder: 'Choose destination drive for file transfer'
	});

	return picked?.value;
}

/**
 * Single file: prompts for a target drive as before. Multiple files: uses
 * whatever drive the CCP is currently sitting on rather than prompting - the
 * point of a multi-file send is firing them all off in one go, and grouping
 * them onto one drive is also what lets SerialTerminal's shared-session
 * batching (one REMOTCCP.COM/SLIDECPM.COM/SLIDE.COM launch for the whole batch) apply.
 */
async function resolveTargetDrive(terminal: SerialTerminal, fileCount: number): Promise<string | undefined> {
	if (fileCount > 1) {
		if (!terminal.isOpen) {
			vscode.window.showErrorMessage('Serial port not connected');
			return undefined;
		}
		const drive = terminal.activeDrive;
		if (!drive) {
			vscode.window.showErrorMessage(
				'Current CP/M drive is not known yet - let the terminal settle on a prompt first, then retry'
			);
		}
		return drive;
	}
	return pickTargetDrive(terminal);
}

export function activate(context: vscode.ExtensionContext) {
	console.log('CP/M IDE extension is now active');

	// Initialize serial terminal backend
	serialTerminal = new SerialTerminal(context);

	// Initialize the webview panel (right-side split panel)
	serialTerminalPanel = new SerialTerminalPanel(serialTerminal, context.extensionUri);

	// DDT's own prompt/status output gets routed here while a debug session
	// is active (SerialTerminal.routeDdtResponse()) - it shows/reveals itself
	// automatically, no command/menu entry needed.
	debugPanel = new DebugPanel(serialTerminal, serialTerminalPanel, context.extensionUri);

	// Initialize file explorer
	cpmFileExplorer = new CpmFileExplorer(serialTerminal);
	cpmFilesView = vscode.window.createTreeView('cpmFilesExplorer', {
		treeDataProvider: cpmFileExplorer,
		// Multiple files can be downloaded in one go via ctrl/shift-click.
		canSelectMany: true
	});
	updateConnectionUi(false);

	// Initialize local workspace file browser (for manual XMODEM sends)
	localFileExplorer = new LocalFileExplorer();
	const localFilesView = vscode.window.createTreeView('cpmLocalFilesExplorer', {
		treeDataProvider: localFileExplorer,
		// Slide can send multiple files in one go via ctrl/shift-click.
		canSelectMany: true
	});

	// Live queue of auto file transfers (manual XMODEM never joins this queue).
	const transfersView = new TransfersView(serialTerminal.transferQueue);
	const transfersTreeView = vscode.window.createTreeView('cpmTransfersView', {
		treeDataProvider: transfersView
	});
	const transferDecorations = vscode.window.registerFileDecorationProvider(
		new TransferDecorationProvider(serialTerminal.transferQueue)
	);

	context.subscriptions.push(
		cpmFilesView,
		localFilesView,
		transfersTreeView,
		transferDecorations
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

		vscode.commands.registerCommand('cpm-ide.debugAssember', async (item: LocalFileSystemItem) => {
			if (!buildManager || !serialTerminal || !item?.resourceUri) {
				return;
			}

			const comPath = await buildManager.assembleFile(item.resourceUri.fsPath);
			if (!comPath) {
				return;
			}
			localFileExplorer?.refresh();

			// No cpmFileExplorer refresh here even though DDT.COM/the .com file
			// just landed on the device - DDT is now running and owns the
			// console, so any further automated DIR/drive-select traffic
			// (what a refresh sends) would land IN the DDT session instead of
			// at a CCP prompt, corrupting it. No serialTerminalPanel.show()
			// either - the DEBUG panel already reveals itself on entering
			// DDT_MODE (DebugPanel's own onDdtModeChanged subscription);
			// showing the main terminal here would just steal focus back.
			await serialTerminal.debugAssemblyFile(comPath);
		}),

		vscode.commands.registerCommand('cpm-ide.debugRemoteFile', async (fileItem: CpmFileItem) => {
			if (serialTerminal && fileItem) {
				await serialTerminal.debugRemoteFile(fileItem.fileName, fileItem.drive);
			}
		}),

		vscode.commands.registerCommand('cpm-ide.openDebugPanel', () => {
			debugPanel?.show();
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

		// `selectedUris` is populated by VS Code when multiple resources are
		// selected in the native Explorer at the time the context menu
		// action is invoked - falls back to the single clicked one otherwise.
		vscode.commands.registerCommand('cpm-ide.transferFileToDevice', async (fileUri: vscode.Uri, selectedUris?: vscode.Uri[]) => {
			if (!serialTerminal) {
				return;
			}
			const uris = (selectedUris && selectedUris.length > 0) ? selectedUris : (fileUri ? [fileUri] : []);
			if (uris.length === 0) {
				return;
			}

			const targetDrive = await resolveTargetDrive(serialTerminal, uris.length);
			if (!targetDrive) {
				return;
			}
			if (await serialTerminal.sendFilesToDevice(uris.map(u => u.fsPath), targetDrive)) {
				await cpmFileExplorer?.refreshDrive(targetDrive);
			}
		}),

		// Local Files tree items aren't real explorer entries, so VS Code
		// passes the tree item itself here rather than a Uri - unwrap it.
		// `selectedItems` is populated the same way as sendFilesSlide below.
		vscode.commands.registerCommand('cpm-ide.transferFileToDeviceFromTree', async (item: LocalFileSystemItem, selectedItems?: LocalFileSystemItem[]) => {
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

			const targetDrive = await resolveTargetDrive(serialTerminal, filePaths.length);
			if (!targetDrive) {
				return;
			}
			if (await serialTerminal.sendFilesToDevice(filePaths, targetDrive)) {
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

			const targetDrive = await resolveTargetDrive(serialTerminal, filePaths.length);
			if (!targetDrive) {
				return;
			}

			if (await serialTerminal.sendFilesToDevice(filePaths, targetDrive)) {
				await cpmFileExplorer?.refreshDrive(targetDrive);
			}
		}),

		// `selectedItems` is populated by VS Code when multiple items are
		// selected (ctrl/shift-click) at the time the context menu action
		// is invoked - falls back to the single clicked item otherwise.
		vscode.commands.registerCommand('cpm-ide.transferFileFromDevice', async (fileItem: CpmFileItem, selectedItems?: CpmFileItem[]) => {
			if (!serialTerminal) {
				return;
			}
			const items = (selectedItems && selectedItems.length > 0) ? selectedItems : (fileItem ? [fileItem] : []);
			if (items.length === 0) {
				return;
			}

			if (await serialTerminal.receiveFilesFromDevice(
				items.map(i => ({ fileName: i.fileName, drive: i.drive, sizeBytes: i.sizeBytes }))
			)) {
				localFileExplorer?.refresh();
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
				`Prepare CP/M first: run \"XMODEM <FILE> /S /X0\" in the terminal (or on the device), then click Start Receive. ` +
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

		vscode.commands.registerCommand('cpm-ide.cancelTransfer', (item: TransferTreeItem) => {
			if (item) {
				serialTerminal?.transferQueue.cancel(item.transfer.id);
			}
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
		// cpmFilesView.message = 'Status: Disconnected';
		// new viewMessage will be ther instead
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
