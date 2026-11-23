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
	forceUpload?: boolean;
	failures?: number;
	nextAttemptAt?: Date;
	lastError?: MirrorErrorCode | null;
};

export type MirrorCollectionStatus = {
	name: string;
	lastMirroredAt: string | null;
	lagSeconds: number;
	pendingWrites: number;
	failures: number;
	lastError: MirrorErrorCode | null;
	nextAttemptAt: string | null;
	externalChangeAt: string | null;
	externalChanges: number;
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

	async requestReconcile(names: readonly string[]): Promise<void> {
		for (const name of names) {
			await this.#collection.updateOne(
				{ _id: name },
				{ $set: { reconcileRequested: true } },
				{ upsert: true },
			);
		}
	}

	async requestRebuild(names: readonly string[]): Promise<void> {
		for (const name of names) {
			await this.#collection.updateOne(
				{ _id: name },
				{
					$set: { forceUpload: true, reconcileRequested: true },
					$unset: { nextAttemptAt: "" },
				},
				{ upsert: true },
			);
		}
	}

	async status(
		names: readonly string[],
		now: Date,
	): Promise<MirrorCollectionStatus[]> {
		const docs = await this.list(names);
		const byId = new Map(docs.map((doc) => [doc._id, doc]));
		return names.map((name) => {
			const doc = byId.get(name);
			if (doc === undefined) {
				return {
					name,
					lastMirroredAt: null,
					lagSeconds: 0,
					pendingWrites: 0,
					failures: 0,
					lastError: null,
					nextAttemptAt: null,
					externalChangeAt: null,
					externalChanges: 0,
				};
			}
			const dirtySeq = doc.dirtySeq ?? 0;
			const mirroredSeq = doc.mirroredSeq ?? 0;
			const pendingWrites = Math.max(0, dirtySeq - mirroredSeq);
			const lagSeconds =
				pendingWrites > 0 && doc.pendingSince !== undefined
					? Math.max(
							0,
							Math.floor((now.getTime() - doc.pendingSince.getTime()) / 1000),
						)
					: 0;
			return {
				name,
				lastMirroredAt: doc.lastMirroredAt?.toISOString() ?? null,
				lagSeconds,
				pendingWrites,
				failures: doc.failures ?? 0,
				lastError: doc.lastError ?? null,
				nextAttemptAt: doc.nextAttemptAt?.toISOString() ?? null,
				externalChangeAt: doc.externalChangeAt?.toISOString() ?? null,
				externalChanges: doc.externalChanges ?? 0,
			};
		});
	}

	async recordFailure(
		name: string,
		token: number,
		code: MirrorErrorCode,
		nextAttemptAt: Date,
	): Promise<boolean> {
		const result = await this.#collection.updateOne(
			{ _id: name, fence: token },
			{
				$inc: { failures: 1 },
				$set: { lastError: code, nextAttemptAt },
			},
		);
		return result.matchedCount === 1;
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
			forceUpload: false,
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
