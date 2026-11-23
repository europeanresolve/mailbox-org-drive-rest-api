import type { FastifyBaseLogger } from "fastify";
import type { Db } from "mongodb";
import type { RecordStore } from "../collections/store.ts";
import type { Config } from "../config/schema.ts";
import { StorageError } from "../storage/errors.ts";
import type { WritableMount } from "../storage/mount-view.ts";
import { MirrorLease } from "./lease.ts";
import { mirrorFilePath, mirrorFolders } from "./path.ts";
import { isDue } from "./schedule.ts";
import type { MirrorStateStore } from "./state.ts";
import type { MirrorTimings } from "./timings.ts";
import { buildWorkbook } from "./workbook.ts";

export class MirrorWorker {
	readonly #config: Config;
	readonly #mount: WritableMount;
	readonly #state: MirrorStateStore;
	readonly #store: RecordStore;
	readonly #timings: MirrorTimings;
	readonly #log: FastifyBaseLogger;
	readonly #lease: MirrorLease;
	#timer: ReturnType<typeof setInterval> | undefined;
	#running: Promise<void> | undefined;

	constructor(options: {
		config: Config;
		db: Db;
		mount: WritableMount;
		state: MirrorStateStore;
		store: RecordStore;
		timings: MirrorTimings;
		log: FastifyBaseLogger;
	}) {
		this.#config = options.config;
		this.#mount = options.mount;
		this.#state = options.state;
		this.#store = options.store;
		this.#timings = options.timings;
		this.#log = options.log;
		this.#lease = new MirrorLease({
			db: options.db,
			ttlMs: options.timings.leaseTtlMs,
		});
	}

	start(): void {
		if (this.#timer !== undefined) return;
		this.#timer = setInterval(() => {
			void this.#tick();
		}, this.#timings.pollMs);
	}

	async stop(): Promise<void> {
		if (this.#timer !== undefined) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		if (this.#running !== undefined) {
			await this.#running;
		}
	}

	async #tick(): Promise<void> {
		if (this.#running !== undefined) return;
		this.#running = this.#pass().finally(() => {
			this.#running = undefined;
		});
		await this.#running;
	}

	async #pass(): Promise<void> {
		const names = Object.keys(this.#config.collections);
		const now = Date.now();
		const states = await this.#state.list(names);
		const due = states.filter((s) => isDue(s, now, this.#timings));
		for (const state of due) {
			await this.#mirrorOne(state._id);
		}
	}

	async #mirrorOne(name: string): Promise<void> {
		const mirror = this.#config.mirror;
		if (mirror === undefined) return;

		const acquired = await this.#lease.acquire(name);
		if (acquired === null) return;
		const { token } = acquired;
		const heartbeatMs = Math.max(1, Math.floor(this.#timings.leaseTtlMs / 3));
		let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
		let leaseLive = true;

		try {
			await this.#state.fence(name, token);
			this.#log.debug({ collection: name, token }, "mirror pass started");

			heartbeatTimer = setInterval(() => {
				void this.#lease.heartbeat(name, token).then((ok) => {
					if (!ok) leaseLive = false;
				});
			}, heartbeatMs);

			const current = await this.#state.read(name);
			if (current === null) return;
			const seq = current.dirtySeq;

			const passReadAt = new Date();
			const records = await this.#store.allSorted(name);
			const collection = this.#config.collections[name];
			if (collection === undefined) return;

			const { buffer, contentHash, notes } = await buildWorkbook(
				name,
				collection.schema,
				records,
				{ maxCellLength: mirror.maxCellLength },
			);

			for (const folder of mirrorFolders(name)) {
				try {
					await this.#mount.stat(folder);
				} catch (error) {
					if (error instanceof StorageError && error.kind === "not-found") {
						await this.#mount.mkdir(folder);
					} else {
						throw error;
					}
				}
			}

			const rel = mirrorFilePath(name);
			let fileExists = false;
			let fileEtag: string | null | undefined;
			try {
				const stat = await this.#mount.stat(rel);
				fileExists = true;
				fileEtag = stat.etag;
			} catch (error) {
				if (error instanceof StorageError && error.kind === "not-found") {
					fileExists = false;
					fileEtag = null;
				} else {
					throw error;
				}
			}

			const storedHash = current.contentHash;
			const lastEtag = current.lastWrittenEtag;
			const skip =
				storedHash === contentHash &&
				fileExists &&
				fileEtag === lastEtag &&
				lastEtag != null;

			const external =
				fileExists &&
				(lastEtag === null ||
					lastEtag === undefined ||
					fileEtag !== lastEtag ||
					fileEtag === null);

			if (!leaseLive) return;

			if (skip) {
				const committed = await this.#state.commit(name, token, {
					seq,
					passReadAt,
				});
				if (!committed) {
					this.#log.warn({ collection: name, token }, "mirror commit fenced");
				} else {
					this.#log.info({ collection: name, token }, "mirror unchanged");
				}
				return;
			}

			const written = await this.#mount.write(rel, buffer);
			const etag = written.etag ?? (await this.#mount.stat(rel)).etag;

			if (!leaseLive) return;

			const committed = await this.#state.commit(name, token, {
				seq,
				passReadAt,
				contentHash,
				lastWrittenEtag: etag,
				...(external
					? { externalChangeAt: new Date(), incExternalChanges: true }
					: {}),
			});
			if (!committed) {
				this.#log.warn({ collection: name, token }, "mirror commit fenced");
				return;
			}

			if (external) {
				this.#log.warn(
					{ collection: name, token },
					"mirror replaced an external change",
				);
			} else {
				this.#log.info(
					{
						collection: name,
						token,
						rows: records.length,
						bytes: buffer.length,
						...notes,
					},
					"mirror written",
				);
			}
		} catch (error) {
			this.#log.warn(
				{
					collection: name,
					token,
					err: {
						type: (error as Error).constructor.name,
						kind: error instanceof StorageError ? error.kind : undefined,
					},
				},
				"mirror pass failed",
			);
		} finally {
			if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
			await this.#lease.release(name, token);
		}
	}
}
