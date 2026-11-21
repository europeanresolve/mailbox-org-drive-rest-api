export type StorageErrorKind =
	| "not-found"
	| "conflict"
	| "forbidden"
	| "unauthorized"
	| "rate-limited"
	| "unavailable"
	| "too-large"
	| "insufficient-storage"
	| "read-only-mount"
	| "invalid-path"
	| "unknown-mount";

export class StorageError extends Error {
	readonly kind: StorageErrorKind;
	readonly op: string;
	readonly status?: number;

	constructor(kind: StorageErrorKind, op: string, status?: number) {
		// Message is op and kind only: it must never carry a path (D-19).
		super(`${op}: ${kind}`);
		this.name = "StorageError";
		this.kind = kind;
		this.op = op;
		if (status !== undefined) this.status = status;
	}
}
