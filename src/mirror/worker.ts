import type { FastifyBaseLogger } from "fastify";
import type { Db } from "mongodb";
import type { RecordStore } from "../collections/store.ts";
import type { Config } from "../config/schema.ts";
import { StorageError } from "../storage/errors.ts";
import type { WritableMount } from "../storage/mount-view.ts";
import { MirrorLease } from "./lease.ts";
import { mirrorFilePath, mirrorFolders } from "./path.ts";
import { backoffMs, isDue } from "./schedule.ts";
import type { MirrorErrorCode, MirrorStateStore } from "./state.ts";
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
	#reconcileTimer: ReturnType<typeof setInterval> | undefined;
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
		const names = Object.keys(this.#config.collections);
		void this.#state.requestReconcile(names).catch((error: unknown) => {
			this.#log.warn({ err: error }, "mirror reconcile request failed");
		});
		this.#timer = setInterval(() => {
			void this.#tick();
		}, this.#timings.pollMs);
		this.#reconcileTimer = setInterval(() => {
			void this.#state.requestReconcile(names).catch((error: unknown) => {
				this.#log.warn({ err: error }, "mirror reconcile request failed");
			});
		}, this.#timings.reconcileMs);
	}

	async stop(): Promise<void> {
		if (this.#reconcileTimer !== undefined) {
			clearInterval(this.#reconcileTimer);
			this.#reconcileTimer = undefined;
		}
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
			let skip =
				!current.forceUpload &&
				storedHash === contentHash &&
				fileExists &&
				fileEtag === lastEtag &&
				lastEtag != null;
			let contentDrift = false;
			if (skip && seq > (current.mirroredSeq ?? 0)) {
				try {
					const onDisk = await this.#mount.read(rel);
					const isZip =
						onDisk.length >= 2 && onDisk[0] === 0x50 && onDisk[1] === 0x4b;
					if (!isZip) {
						skip = false;
						contentDrift = true;
					}
				} catch {
					skip = false;
					contentDrift = true;
				}
			}

			const external =
				contentDrift ||
				(fileExists &&
					(lastEtag === null ||
						lastEtag === undefined ||
						fileEtag !== lastEtag ||
						fileEtag === null));

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
			const code = mirrorErrorCode(error);
			const current = await this.#state.read(name);
			const failures = current?.failures ?? 0;
			const delay = backoffMs(failures + 1, this.#timings);
			const nextAttemptAt = new Date(Date.now() + delay);
			await this.#state.recordFailure(name, token, code, nextAttemptAt);
			this.#log.warn({ collection: name, code }, "mirror pass failed");
		} finally {
			if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
			await this.#lease.release(name, token);
		}
	}
}

const STORAGE_CODES = new Set<MirrorErrorCode>([
	"not-found",
	"conflict",
	"forbidden",
	"unauthorized",
	"rate-limited",
	"unavailable",
	"too-large",
	"insufficient-storage",
	"read-only-mount",
	"invalid-path",
]);

function mirrorErrorCode(error: unknown): MirrorErrorCode {
	if (error instanceof StorageError) {
		if (STORAGE_CODES.has(error.kind as MirrorErrorCode)) {
			return error.kind as MirrorErrorCode;
		}
		return "internal";
	}
	if (error instanceof Error && error.message.includes("workbook")) {
		return "workbook";
	}
	return "internal";
}
