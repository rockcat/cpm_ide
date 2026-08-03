import * as vscode from 'vscode';

export type TransferDirection = 'send' | 'receive';
export type TransferStatus = 'queued' | 'active' | 'error';

/** Thrown by a transfer engine when its `isCancelled()` check trips. */
export class TransferCancelledError extends Error {
	constructor(fileName: string) {
		super(`Transfer of ${fileName} was cancelled`);
		this.name = 'TransferCancelledError';
	}
}

/**
 * Thrown by SerialTerminal's low-level polling helpers (waitForPrompt(),
 * waitForIdle()) when they notice the connection was reset/disconnected
 * out from under an in-progress background operation (a drive/file scan,
 * a DIR listing, an install probe, ...) - unwinds that operation
 * immediately instead of letting it keep polling/writing for its full
 * original timeout budget against a connection that's gone, or - worse -
 * a newly-reopened one it was never meant to talk to. Callers that catch
 * TransferCancelledError to treat cancellation as a benign, non-error
 * outcome should check for this alongside it.
 */
export class ConnectionResetError extends Error {
	constructor() {
		super('Connection was reset');
		this.name = 'ConnectionResetError';
	}
}

let nextId = 1;

export interface TransferItem {
	readonly id: number;
	readonly fileName: string;
	readonly direction: TransferDirection;
	readonly totalBytes: number;
	status: TransferStatus;
	bytesTransferred: number;
	errorMessage?: string;
	cancelled: boolean;
}

export type ProgressFn = (bytesTransferred: number) => void;
export type IsCancelledFn = () => boolean;

/**
 * Queues auto file transfers (manual XMODEM never touches this) so multiple
 * can be requested while one is in flight. `withExclusiveAccess` in
 * SerialTerminal is not itself a mutex - it only tracks a busy flag around a
 * single call - so this queue's `tail` promise chain is what actually
 * guarantees only one transfer's `run` touches the wire at a time.
 */
export class TransferQueue {
	/** Fires with a specific item's id for an in-place progress tick, or undefined for a structural change (added/removed/status change) that needs a full-list refresh. */
	private _onDidChange = new vscode.EventEmitter<number | undefined>();
	readonly onDidChange = this._onDidChange.event;

	private items: TransferItem[] = [];
	private tail: Promise<void> = Promise.resolve();

	get all(): readonly TransferItem[] {
		return this.items;
	}

	/**
	 * Adds a `queued` row immediately, then runs `run` once every
	 * previously-enqueued transfer has finished. `run` reports raw
	 * cumulative bytes via its `onProgress` callback; the queue converts
	 * that to a percentage using `totalBytes` (pass 0 if unknown - the view
	 * falls back to showing a byte count instead of a percentage).
	 *
	 * Resolves/rejects exactly like `run` did for a genuine success/failure,
	 * so callers' existing try/catch keeps working unchanged. Rejects with
	 * TransferCancelledError if the item was cancelled before or during
	 * `run` - callers should treat that distinctly from a real failure.
	 */
	enqueue<T>(
		fileName: string,
		direction: TransferDirection,
		totalBytes: number,
		run: (onProgress: ProgressFn, isCancelled: IsCancelledFn) => Promise<T>
	): Promise<T> {
		const item: TransferItem = {
			id: nextId++,
			fileName,
			direction,
			totalBytes,
			status: 'queued',
			bytesTransferred: 0,
			cancelled: false,
		};
		this.items.push(item);
		this._onDidChange.fire(undefined);

		const runItem = async (): Promise<T> => {
			if (item.cancelled) {
				this.remove(item.id);
				throw new TransferCancelledError(fileName);
			}
			item.status = 'active';
			this._onDidChange.fire(undefined);
			try {
				const result = await run(
					(bytesTransferred) => {
						item.bytesTransferred = bytesTransferred;
						// Granular: fires for just this row, so a fast run of
						// per-block updates doesn't get coalesced into a single
						// full-tree refresh that only shows the final value.
						this._onDidChange.fire(item.id);
					},
					() => item.cancelled
				);
				this.remove(item.id);
				return result;
			} catch (error) {
				if (item.cancelled || error instanceof TransferCancelledError) {
					this.remove(item.id);
					throw error instanceof TransferCancelledError ? error : new TransferCancelledError(fileName);
				}
				item.status = 'error';
				item.errorMessage = error instanceof Error ? error.message : String(error);
				this._onDidChange.fire(undefined);
				throw error;
			}
		};

		const resultPromise = this.tail.then(runItem, runItem);
		// Keep the chain moving regardless of this item's outcome - a
		// rejection here must not stop the next enqueued transfer from running.
		this.tail = resultPromise.then(() => undefined, () => undefined);
		return resultPromise;
	}

	/**
	 * Requests cancellation. For a still-`queued` item this skips it
	 * entirely when its turn comes; for an `active` item it relies on the
	 * transfer engine's own `isCancelled()` checks to unwind; for an
	 * `error` item there's nothing running, so this is just a dismiss.
	 */
	cancel(id: number): void {
		const item = this.items.find(i => i.id === id);
		if (!item) {
			return;
		}
		if (item.status === 'error') {
			this.remove(id);
			return;
		}
		item.cancelled = true;
		this._onDidChange.fire(undefined);
	}

	remove(id: number): void {
		const idx = this.items.findIndex(i => i.id === id);
		if (idx >= 0) {
			this.items.splice(idx, 1);
			this._onDidChange.fire(undefined);
		}
	}
}
