import type { Db } from "mongodb";
import type { MirrorTimings } from "./timings.ts";

export type MirrorErrorCode =
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
	| "workbook"
	| "internal";

export type MirrorState = {
	_id: string;
	dirtySeq: number;
	mirroredSeq: number;
	dueAt: Date;
	fence?: number;
	lastMirroredAt?: Date;
	contentHash?: string;
	lastWrittenEtag?: string | null;
	externalChangeAt?: Date;
	externalChanges?: number;
	pendingSince?: Date;
	reconcileRequested?: boolean;
	failures?: number;
	nextAttemptAt?: Date;
	lastError?: MirrorErrorCode | null;
};

export class MirrorStateStore {
	readonly #collection;
	readonly #debounceMs: number;

	constructor(db: Db, timings: MirrorTimings) {
		this.#collection = db.collection<MirrorState>("mirror_state");
		this.#debounceMs = timings.debounceMs;
	}

	async markDirty(name: string): Promise<void> {
		const now = new Date();
		const dueAt = new Date(Date.now() + this.#debounceMs);
		await this.#collection.updateOne(
			{ _id: name },
			{
				$inc: { dirtySeq: 1 },
				$max: { dueAt },
				$min: { pendingSince: now },
				$setOnInsert: { mirroredSeq: 0 },
			},
			{ upsert: true },
		);
	}

	async list(names: readonly string[]): Promise<MirrorState[]> {
		if (names.length === 0) return [];
		return this.#collection.find({ _id: { $in: [...names] } }).toArray();
	}

	async read(name: string): Promise<MirrorState | null> {
		return this.#collection.findOne({ _id: name });
	}

	async fence(name: string, token: number): Promise<void> {
		await this.#collection.updateOne(
			{ _id: name },
			{ $max: { fence: token } },
			{ upsert: true },
		);
	}

	async commit(
		name: string,
		token: number,
		fields: {
			seq: number;
			passReadAt?: Date;
			contentHash?: string;
			lastWrittenEtag?: string | null;
			lastMirroredAt?: Date;
			externalChangeAt?: Date;
			incExternalChanges?: boolean;
			clearReconcile?: boolean;
		},
	): Promise<boolean> {
		const doc = await this.#collection.findOne({ _id: name, fence: token });
		if (doc === null) return false;

		const set: Record<string, unknown> = {
			mirroredSeq: fields.seq,
			reconcileRequested: false,
			failures: 0,
			lastError: null,
		};
		if (fields.contentHash !== undefined) set.contentHash = fields.contentHash;
		if (fields.lastWrittenEtag !== undefined) {
			set.lastWrittenEtag = fields.lastWrittenEtag;
		}
		if (fields.lastMirroredAt !== undefined) {
			set.lastMirroredAt = fields.lastMirroredAt;
		} else {
			set.lastMirroredAt = new Date();
		}
		if (fields.externalChangeAt !== undefined) {
			set.externalChangeAt = fields.externalChangeAt;
		}
		const unset: Record<string, unknown> = { nextAttemptAt: "" };
		if (doc.dirtySeq === fields.seq) {
			unset.pendingSince = "";
		} else if (fields.passReadAt !== undefined) {
			set.pendingSince = fields.passReadAt;
		}

		const update: Record<string, unknown> = { $set: set, $unset: unset };
		if (fields.incExternalChanges === true) {
			update.$inc = { externalChanges: 1 };
		}
		const result = await this.#collection.updateOne(
			{ _id: name, fence: token },
			update,
		);
		return result.matchedCount === 1;
	}
}
