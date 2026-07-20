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

	private async loadDrivesAndFiles() {
		// Runs with exclusive control of the serial line, since scanning
		// drives and listing files sends its own commands to the CP/M
		// console and would corrupt anything the user is typing at the
		// terminal if the two ran concurrently.
		await this.serialTerminal.withExclusiveAccess('Refreshing CP/M file list…', async () => {
			const drives = await this.serialTerminal.scanDrives();

			for (const drive of drives) {
				try {
					const files = await this.serialTerminal.getDirListing(drive);
					const cpmFiles = files.map(f => ({
						name: f,
						drive: drive,
						type: f.split('.')[1] || 'FILE',
					}));
					this.drives.set(drive, cpmFiles);
				} catch (error) {
					// Skip this drive and keep listing the rest.
				}
			}
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
		this.command = {
			command: 'vscode.openFolder',
			title: 'View File',
			arguments: [],
		};
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
