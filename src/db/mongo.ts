import { MongoClient } from "mongodb";

export interface Mongo {
	client: MongoClient;
	/** The only MongoDB command Phase 1 sends (D-22). */
	ping(): Promise<void>;
	close(): Promise<void>;
}

/**
 * The client is lazy: nothing connects until the first command, so building the
 * app needs no running MongoDB. A short server selection timeout keeps /ready fast.
 */
export function createMongo(uri: string): Mongo {
	const client = new MongoClient(uri, { serverSelectionTimeoutMS: 1500 });
	return {
		client,
		ping: async () => {
			await client.db("admin").command({ ping: 1 });
		},
		close: () => client.close(),
	};
}
