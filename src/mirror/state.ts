import type { Db } from "mongodb";
import type { MirrorTimings } from "./timings.ts";

export type MirrorState = {
	_id: string;
	dirtySeq: number;
	mirroredSeq: number;
	dueAt: Date;
	lastMirroredAt?: Date;
	contentHash?: string;
	lastWrittenEtag?: string | null;
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

	async commit(
		name: string,
		fields: {
			seq: number;
			contentHash: string;
			lastWrittenEtag: string | null;
		},
	): Promise<void> {
		await this.#collection.updateOne(
			{ _id: name },
			{
				$set: {
					mirroredSeq: fields.seq,
					contentHash: fields.contentHash,
					lastWrittenEtag: fields.lastWrittenEtag,
					lastMirroredAt: new Date(),
				},
			},
		);
	}
}
