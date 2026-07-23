import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export class LocalFileExplorer implements vscode.TreeDataProvider<LocalFileSystemItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<LocalFileSystemItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	refresh(): void {
		this._onDidChangeTreeData.fire(undefined);
	}

	getTreeItem(element: LocalFileSystemItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: LocalFileSystemItem): LocalFileSystemItem[] {
		const dir = element ? element.resourceUri!.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!dir) {
			return [];
		}

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch (error) {
			return [];
		}

		return entries
			.filter(entry => !entry.name.startsWith('.'))
			.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
			.map(entry => new LocalFileSystemItem(path.join(dir, entry.name), entry.isDirectory()));
	}
}

const ASM_EXTENSIONS = new Set(['.asm', '.s', '.z80']);
const C_EXTENSIONS = new Set(['.c']);

export class LocalFileSystemItem extends vscode.TreeItem {
	constructor(fsPath: string, public readonly isDirectory: boolean) {
		super(
			path.basename(fsPath),
			isDirectory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
		);
		this.resourceUri = vscode.Uri.file(fsPath);
		this.iconPath = isDirectory ? vscode.ThemeIcon.Folder : vscode.ThemeIcon.File;

		if (isDirectory) {
			this.contextValue = 'localFolder';
		} else {
			// Suffixed so "Assemble"/"Compile" menu items can target just
			// their file type while send/manual-send still match any file
			// via a `viewItem =~ /^localFile/` when-clause.
			const ext = path.extname(fsPath).toLowerCase();
			this.contextValue = ASM_EXTENSIONS.has(ext) ? 'localFile-asm'
				: C_EXTENSIONS.has(ext) ? 'localFile-c'
				: 'localFile';
			this.command = {
				command: 'vscode.open',
				title: 'Open File',
				arguments: [this.resourceUri],
			};
		}
	}
}
