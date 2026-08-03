import * as vscode from 'vscode';
import { SerialTerminal } from './serialTerminal';
import { formatFileSize } from './formatFileSize';
import { ConnectionResetError } from './transferQueue';

export interface CpmFile {
	name: string;
	drive: string;
	type: string;
	sizeBytes?: number;
}

/** What both the Remote CCP path (record count) and the plain DIR fallback (name only) can supply. */
interface CpmFileSource {
	name: string;
	recordCount?: number;
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
		try {
			await this.loadDrivesAndFiles();
		} catch (error) {
			if (error instanceof ConnectionResetError || !this.serialTerminal.isOpen) {
				// The connection was reset mid-scan (or a stale Remote CCP
				// read simply timed out after one, well after the
				// disconnect itself) - serialTerminal's own onDisconnect
				// handler already clears this tree, so there's nothing left
				// to do here either way.
				return;
			}
			throw error;
		}
		this._onDidChangeTreeData.fire(undefined);
	}

	/**
	 * Re-lists just `drive`, instead of the full scanDrives() + per-drive
	 * DIR sweep that refresh() does - for updating the tree after an upload
	 * lands on a known drive, where re-probing every drive A-P is wasted
	 * device I/O for information we already have.
	 */
	async refreshDrive(drive: string): Promise<void> {
		try {
			await this.serialTerminal.withExclusiveAccess(`Refreshing ${drive}: file list…`, async () => {
				try {
					const files = await this.serialTerminal.listFilesViaRemoteCcp(drive)
						?? (await this.serialTerminal.getDirListing(drive)).map(name => ({ name }));
					this.storeFileList(drive, files);
				} catch (error) {
					if (error instanceof ConnectionResetError || !this.serialTerminal.isOpen) {
						throw error;
					}
					// Leave the previous listing for this drive in place.
				}
			});
		} catch (error) {
			if (error instanceof ConnectionResetError || !this.serialTerminal.isOpen) {
				return;
			}
			throw error;
		}
		this._onDidChangeTreeData.fire(undefined);
	}

	clear(): void {
		this.drives.clear();
		this._onDidChangeTreeData.fire(undefined);
	}

	/**
	 * recordCount (128-byte CP/M records, from the Remote CCP FL command)
	 * converts straight to a byte size; the plain DIR fallback has no size
	 * info at all, so sizeBytes is left undefined for those entries.
	 */
	private toCpmFiles(drive: string, files: CpmFileSource[]): CpmFile[] {
		return files
			.map(f => ({
				name: f.name,
				drive: drive,
				type: f.name.split('.')[1] || 'FILE',
				sizeBytes: f.recordCount !== undefined ? f.recordCount * 128 : undefined,
			}))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	private storeFileList(drive: string, files: CpmFileSource[]): void {
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
					scanned.set(drive, this.toCpmFiles(drive, files.map(name => ({ name }))));
				} catch (error) {
					if (error instanceof ConnectionResetError || !this.serialTerminal.isOpen) {
						// Stop entirely rather than ploughing through the
						// remaining drives against a connection that's gone.
						throw error;
					}
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
			return files.map(file => new CpmFileItem(file.name, file.drive, file.type, file.sizeBytes));
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
		public fileType: string,
		public sizeBytes?: number
	) {
		super(fileName);
		// Suffixed for .COM specifically so the "Debug" inline button
		// (launch DDT directly against a file already on the device, no
		// transfer) can target just those, while "Download" still matches
		// any file via a `viewItem =~ /^cpmFile/` when-clause.
		this.contextValue = fileType === 'COM' ? 'cpmFile-com' : 'cpmFile';

		// Set icon based on file type
		if (['COM', 'EXE', 'BIN'].includes(fileType)) {
			this.iconPath = new vscode.ThemeIcon('symbol-function');
		} else if (['ASM', 'C', 'PAS'].includes(fileType)) {
			this.iconPath = new vscode.ThemeIcon('symbol-file');
		} else {
			this.iconPath = new vscode.ThemeIcon('file');
		}

		this.tooltip = `${fileName} on drive ${drive}:`;
		if (sizeBytes !== undefined) {
			this.description = formatFileSize(sizeBytes);
			this.tooltip += ` (${formatFileSize(sizeBytes)})`;
		}
	}
}
