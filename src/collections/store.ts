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

	/** `id` is given when an idempotency entry chose it before the record existed. */
	async insert(
		name: string,
		data: Record<string, unknown>,
		id: string = crypto.randomUUID(),
	): Promise<RecordDocument> {
		const now = new Date().toISOString();
		const document: RecordDocument = {
			_id: id,
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
	 * Replaces `data` as a whole and bumps the version, in one atomic operation.
	 * With `versions` the document is only touched when its current version is one
	 * of them (an empty list matches nothing). Null means no document matched:
	 * the caller tells a missing id from a stale version with a follow-up findById.
	 * `_id` and `createdAt` are never in the update.
	 */
	async replace(
		name: string,
		id: string,
		data: Record<string, unknown>,
		versions?: readonly number[],
	): Promise<RecordDocument | null> {
		const filter: Filter<RecordDocument> =
			versions === undefined
				? { _id: id }
				: { _id: id, _v: { $in: [...versions] } };
		return this.#records(name).findOneAndUpdate(
			filter,
			{
				$set: { data, updatedAt: new Date().toISOString() },
				$inc: { _v: 1 },
			},
			{ returnDocument: "after" },
		);
	}

	/** Full collection in stable mirror order (D-12). */
	async allSorted(name: string): Promise<RecordDocument[]> {
		return this.#records(name)
			.find({})
			.sort({ createdAt: 1, _id: 1 })
			.toArray();
	}

	/** Hard delete (D-13). True when a document was removed. */
	async remove(name: string, id: string): Promise<boolean> {
		const result = await this.#records(name).deleteOne({ _id: id });
		return result.deletedCount === 1;
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
