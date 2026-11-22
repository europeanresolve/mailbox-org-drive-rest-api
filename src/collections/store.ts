import type { Db } from "mongodb";

export type RecordDocument = {
	_id: string;
	_v: number;
	createdAt: string;
	updatedAt: string;
	/** The user's fields. Nested under `data` so they can never collide with server fields. */
	data: Record<string, unknown>;
};

/** One MongoDB collection `records_<name>` per configured collection. Single-document operations only. */
export class RecordStore {
	readonly #db: Db;

	constructor(db: Db) {
		this.#db = db;
	}

	#records(name: string) {
		return this.#db.collection<RecordDocument>(`records_${name}`);
	}

	async insert(
		name: string,
		data: Record<string, unknown>,
	): Promise<RecordDocument> {
		const now = new Date().toISOString();
		const document: RecordDocument = {
			_id: crypto.randomUUID(),
			_v: 1,
			createdAt: now,
			updatedAt: now,
			data,
		};
		await this.#records(name).insertOne({ ...document });
		return document;
	}

	/** The id comes from the URL but is only ever a filter value, never a filter key. */
	async findById(name: string, id: string): Promise<RecordDocument | null> {
		return this.#records(name).findOne({ _id: id });
	}
}
