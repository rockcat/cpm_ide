import * as vscode from 'vscode';
import { TransferItem, TransferQueue } from './transferQueue';
import { formatFileSize } from './formatFileSize';

const URI_SCHEME = 'cpm-transfer';

function transferUri(id: number): vscode.Uri {
	return vscode.Uri.from({ scheme: URI_SCHEME, path: String(id) });
}

export class TransferTreeItem extends vscode.TreeItem {
	public transfer: TransferItem;

	constructor(transfer: TransferItem) {
		super(transfer.fileName, vscode.TreeItemCollapsibleState.None);
		this.transfer = transfer;
		this.id = String(transfer.id);
		this.resourceUri = transferUri(transfer.id);
		this.contextValue = 'transferItem';
		this.applyPresentation();
	}

	/**
	 * Mutates this same instance's label/description/icon in place, rather
	 * than the caller building a fresh TreeItem - VS Code's per-element
	 * onDidChangeTreeData.fire(element) only re-renders correctly for an
	 * element it already knows about (one it got from a prior getChildren()
	 * call), so the identity has to stay stable across progress ticks.
	 */
	updateFrom(transfer: TransferItem): void {
		this.transfer = transfer;
		this.applyPresentation();
	}

	private applyPresentation(): void {
		const transfer = this.transfer;
		const percent = transfer.totalBytes > 0
			? Math.min(100, Math.round((transfer.bytesTransferred / transfer.totalBytes) * 100))
			: undefined;
		const progressText = percent !== undefined ? `${percent}%` : formatFileSize(transfer.bytesTransferred);

		this.description = transfer.status === 'error' ? (transfer.errorMessage ?? 'Failed') : progressText;
		this.tooltip = transfer.status === 'error'
			? `${transfer.fileName}: ${transfer.errorMessage ?? 'Failed'}`
			: `${transfer.fileName} - ${progressText}`;

		const iconName = transfer.direction === 'send' ? 'cloud-upload' : 'cloud-download';
		this.iconPath = new vscode.ThemeIcon(
			iconName,
			transfer.status === 'error' ? new vscode.ThemeColor('errorForeground') : undefined
		);
	}
}

export class TransfersView implements vscode.TreeDataProvider<TransferTreeItem> {
	private _onDidChangeTreeData = new vscode.EventEmitter<TransferTreeItem | undefined>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	/** Keyed by TransferItem.id - kept stable across refreshes so per-item progress ticks can target one row instead of forcing a full-tree refresh. */
	private treeItems = new Map<number, TransferTreeItem>();

	constructor(private readonly queue: TransferQueue) {
		this.syncTreeItems();
		queue.onDidChange((changedId) => {
			if (changedId !== undefined) {
				const treeItem = this.treeItems.get(changedId);
				const transfer = this.queue.all.find(i => i.id === changedId);
				if (treeItem && transfer) {
					treeItem.updateFrom(transfer);
					this._onDidChangeTreeData.fire(treeItem);
					return;
				}
			}
			// Structural change (item added/removed, or a status flip we
			// didn't already resolve above) - resync the whole list.
			this.syncTreeItems();
			this._onDidChangeTreeData.fire(undefined);
		});
	}

	private syncTreeItems(): void {
		const liveIds = new Set(this.queue.all.map(i => i.id));
		for (const id of this.treeItems.keys()) {
			if (!liveIds.has(id)) {
				this.treeItems.delete(id);
			}
		}
		for (const transfer of this.queue.all) {
			const existing = this.treeItems.get(transfer.id);
			if (existing) {
				existing.updateFrom(transfer);
			} else {
				this.treeItems.set(transfer.id, new TransferTreeItem(transfer));
			}
		}
	}

	getTreeItem(element: TransferTreeItem): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TransferTreeItem): TransferTreeItem[] {
		if (element) {
			return [];
		}
		return this.queue.all.map(item => this.treeItems.get(item.id)!);
	}
}

/**
 * TreeItem has no direct "colored label text" property - a
 * FileDecorationProvider keyed off each row's synthetic resourceUri is the
 * actual VS Code mechanism for that, used here to turn a failed transfer's
 * name red (the icon is tinted separately in TransferTreeItem itself).
 */
export class TransferDecorationProvider implements vscode.FileDecorationProvider {
	private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
	readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

	constructor(private readonly queue: TransferQueue) {
		queue.onDidChange(() => this._onDidChangeFileDecorations.fire(undefined));
	}

	provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
		if (uri.scheme !== URI_SCHEME) {
			return undefined;
		}
		const id = Number(uri.path);
		const item = this.queue.all.find(i => i.id === id);
		if (item?.status === 'error') {
			return new vscode.FileDecoration(undefined, undefined, new vscode.ThemeColor('errorForeground'));
		}
		return undefined;
	}
}
