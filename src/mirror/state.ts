import type { Db } from "mongodb";
import type { MirrorTimings } from "./timings.ts";

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
};

export class MirrorStateStore {
	readonly #collection;
	readonly #debounceMs: number;

	constructor(db: Db, timings: MirrorTimings) {
		this.#collection = db.collection<MirrorState>("mirror_state");
		this.#debounceMs = timings.debounceMs;
	}

	async markDirty(name: string): Promise<void> {
		const dueAt = new Date(Date.now() + this.#debounceMs);
		await this.#collection.updateOne(
			{ _id: name },
			{
				$inc: { dirtySeq: 1 },
				$max: { dueAt },
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
			contentHash?: string;
			lastWrittenEtag?: string | null;
			lastMirroredAt?: Date;
			externalChangeAt?: Date;
			incExternalChanges?: boolean;
		},
	): Promise<boolean> {
		const set: Record<string, unknown> = { mirroredSeq: fields.seq };
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
		const update: Record<string, unknown> = { $set: set };
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
