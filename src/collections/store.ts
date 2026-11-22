import type { Db, Document, Filter } from "mongodb";
import type { ParsedList } from "./list-query.ts";

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

	/**
	 * Keyset page. The MongoDB filter is built here from parsed, typed conditions only
	 * (JS scalars under allow-listed field names), never spread from client input.
	 */
	async list(
		name: string,
		parsed: ParsedList,
	): Promise<{ items: RecordDocument[]; hasMore: boolean }> {
		const conditions: Document[] = parsed.filters.map(
			({ field, op, value }) => ({ [field]: { [`$${op}`]: value } }),
		);
		const { field, dir } = parsed.sort;
		if (parsed.after !== undefined) {
			const { v, id } = parsed.after;
			const beyond = dir === 1 ? "$gt" : "$lt";
			conditions.push({
				$or: [
					{ [field]: { [beyond]: v } },
					{ [field]: { $eq: v }, _id: { [beyond]: id } },
				],
			});
		}
		const found = await this.#records(name)
			.find(
				(conditions.length === 0
					? {}
					: { $and: conditions }) as Filter<RecordDocument>,
			)
			.sort({ [field]: dir, _id: dir })
			// One extra document tells whether another page exists.
			.limit(parsed.limit + 1)
			.toArray();
		return {
			items: found.slice(0, parsed.limit),
			hasMore: found.length > parsed.limit,
		};
	}
}
