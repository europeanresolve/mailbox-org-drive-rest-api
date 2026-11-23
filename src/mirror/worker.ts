import type { FastifyBaseLogger } from "fastify";
import type { RecordStore } from "../collections/store.ts";
import type { Config } from "../config/schema.ts";
import { StorageError } from "../storage/errors.ts";
import type { WritableMount } from "../storage/mount-view.ts";
import { mirrorFilePath, mirrorFolders } from "./path.ts";
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
	#timer: ReturnType<typeof setInterval> | undefined;
	#running: Promise<void> | undefined;

	constructor(options: {
		config: Config;
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
		const due = states.filter(
			(s) => s.dirtySeq > s.mirroredSeq && s.dueAt.getTime() <= now,
		);
		for (const state of due) {
			await this.#mirrorOne(state._id, state.dirtySeq);
		}
	}

	async #mirrorOne(name: string, seq: number): Promise<void> {
		const mirror = this.#config.mirror;
		if (mirror === undefined) return;
		try {
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
			const written = await this.#mount.write(rel, buffer);
			const etag = written.etag ?? (await this.#mount.stat(rel)).etag;
			await this.#state.commit(name, {
				seq,
				contentHash,
				lastWrittenEtag: etag,
			});
			this.#log.info(
				{
					collection: name,
					rows: records.length,
					bytes: buffer.length,
					...notes,
				},
				"mirror written",
			);
		} catch (error) {
			this.#log.warn(
				{
					collection: name,
					err: {
						type: (error as Error).constructor.name,
						kind: error instanceof StorageError ? error.kind : undefined,
					},
				},
				"mirror pass failed",
			);
		}
	}
}
