import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { Db } from "mongodb";
import { isDuplicateKey } from "../collections/idempotency.ts";

type LeaseDoc = {
	_id: string;
	owner: string;
	token: number;
	expiresAt: Date;
};

export class MirrorLease {
	readonly #collection;
	readonly #ttlMs: number;
	readonly #owner: string;

	constructor(options: { db: Db; ttlMs: number }) {
		this.#collection = options.db.collection<LeaseDoc>("mirror_leases");
		this.#ttlMs = options.ttlMs;
		this.#owner = `${hostname()}:${process.pid}:${randomUUID()}`;
	}

	async acquire(name: string): Promise<{ token: number } | null> {
		const now = new Date();
		const expiresAt = new Date(now.getTime() + this.#ttlMs);
		try {
			const doc = await this.#collection.findOneAndUpdate(
				{
					_id: name,
					$or: [
						{ expiresAt: { $lte: now } },
						{ expiresAt: { $exists: false } },
					],
				},
				{
					$set: { owner: this.#owner, expiresAt },
					$inc: { token: 1 },
				},
				{ upsert: true, returnDocument: "after" },
			);
			if (doc === null || doc.owner !== this.#owner) return null;
			return { token: doc.token };
		} catch (error) {
			if (isDuplicateKey(error)) return null;
			throw error;
		}
	}

	async heartbeat(name: string, token: number): Promise<boolean> {
		const now = new Date();
		const expiresAt = new Date(now.getTime() + this.#ttlMs);
		const result = await this.#collection.updateOne(
			{ _id: name, owner: this.#owner, token },
			{ $set: { expiresAt } },
		);
		return result.matchedCount === 1;
	}

	async release(name: string, token: number): Promise<void> {
		await this.#collection.updateOne(
			{ _id: name, owner: this.#owner, token },
			{ $set: { expiresAt: new Date(0) } },
		);
	}
}
