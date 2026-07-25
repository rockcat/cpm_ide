import * as vscode from 'vscode';
import { SerialTerminal } from './serialTerminal';

export interface CpmFile {
	name: string;
	drive: string;
	type: string;
}

export interface CpmDrive {
	letter: string;
	files: CpmFile[];
}

export class CpmFileExplorer implements vscode.TreeDataProvider<CpmDriveItem | CpmFileItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<CpmDriveItem | CpmFileItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private drives: Map<string, CpmFile[]> = new Map();
	private serialTerminal: SerialTerminal;

	constructor(serialTerminal: SerialTerminal) {
		this.serialTerminal = serialTerminal;
		// Don't load on init - wait for user to connect via serial terminal
	}

	async refresh(): Promise<void> {
		await this.loadDrivesAndFiles();
		this._onDidChangeTreeData.fire(undefined);
	}

	/**
	 * Re-lists just `drive`, instead of the full scanDrives() + per-drive
	 * DIR sweep that refresh() does - for updating the tree after an upload
	 * lands on a known drive, where re-probing every drive A-P is wasted
	 * device I/O for information we already have.
	 */
	async refreshDrive(drive: string): Promise<void> {
		await this.serialTerminal.withExclusiveAccess(`Refreshing ${drive}: file list…`, async () => {
			try {
				const files = await this.serialTerminal.listFilesViaRemoteCcp(drive)
					?? await this.serialTerminal.getDirListing(drive);
				this.storeFileList(drive, files);
			} catch (error) {
				// Leave the previous listing for this drive in place.
			}
		});
		this._onDidChangeTreeData.fire(undefined);
	}

	clear(): void {
		this.drives.clear();
		this._onDidChangeTreeData.fire(undefined);
	}

	private toCpmFiles(drive: string, files: string[]): CpmFile[] {
		return files.map(f => ({
			name: f,
			drive: drive,
			type: f.split('.')[1] || 'FILE',
		}));
	}

	private storeFileList(drive: string, files: string[]): void {
		this.drives.set(drive, this.toCpmFiles(drive, files));
	}

	private async loadDrivesAndFiles() {
		// Runs with exclusive control of the serial line, since scanning
		// drives and listing files sends its own commands to the CP/M
		// console and would corrupt anything the user is typing at the
		// terminal if the two ran concurrently.
		await this.serialTerminal.withExclusiveAccess('Refreshing CP/M file list…', async () => {
			const viaRemoteCcp = await this.serialTerminal.scanDrivesAndFilesViaRemoteCcp();
			if (viaRemoteCcp) {
				// Rebuild from scratch and swap in at the end, rather than
				// merging into the existing map, so a drive that has gone
				// away (or failed) since the last scan doesn't linger with
				// its stale file list.
				const scanned = new Map<string, CpmFile[]>();
				for (const [drive, files] of viaRemoteCcp) {
					scanned.set(drive, this.toCpmFiles(drive, files));
				}
				this.drives = scanned;
				return;
			}

			// Remote CCP unavailable - fall back to the CCP-command approach.
			const drives = await this.serialTerminal.scanDrives();
			const scanned = new Map<string, CpmFile[]>();
			for (const drive of drives) {
				try {
					const files = await this.serialTerminal.getDirListing(drive);
					scanned.set(drive, this.toCpmFiles(drive, files));
				} catch (error) {
					// Drive no longer responds to a DIR listing - drop it
					// rather than keeping its last-known file list around.
				}
			}
			this.drives = scanned;
		});
	}

	getTreeItem(element: CpmDriveItem | CpmFileItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: CpmDriveItem | CpmFileItem): vscode.ProviderResult<(CpmDriveItem | CpmFileItem)[]> {
		if (!element) {
			// Root level - show drives
			return Array.from(this.drives.keys()).sort().map(drive => new CpmDriveItem(drive));
		}

		if (element instanceof CpmDriveItem) {
			// Show files in this drive
			const files = this.drives.get(element.drive) || [];
			return files.map(file => new CpmFileItem(file.name, file.drive, file.type));
		}

		return [];
	}
}

export class CpmDriveItem extends vscode.TreeItem {
	constructor(public drive: string) {
		super(`Drive ${drive}:`, vscode.TreeItemCollapsibleState.Collapsed);
		this.iconPath = new vscode.ThemeIcon('folder');
		this.contextValue = 'cpmDrive';
	}
}

export class CpmFileItem extends vscode.TreeItem {
	constructor(
		public fileName: string,
		public drive: string,
		public fileType: string
	) {
		super(fileName);
		this.contextValue = 'cpmFile';

		// Set icon based on file type
		if (['COM', 'EXE', 'BIN'].includes(fileType)) {
			this.iconPath = new vscode.ThemeIcon('symbol-function');
		} else if (['ASM', 'C', 'PAS'].includes(fileType)) {
			this.iconPath = new vscode.ThemeIcon('symbol-file');
		} else {
			this.iconPath = new vscode.ThemeIcon('file');
		}

		this.tooltip = `${fileName} on drive ${drive}:`;
	}
}
