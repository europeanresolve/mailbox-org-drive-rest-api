import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { StorageAdapter } from "../../src/storage/adapter.ts";
import type { ResolvedPath } from "../../src/storage/mounts.ts";

export type ContractSetup = () => Promise<{
	adapter: StorageAdapter;
	path: (rel: string) => ResolvedPath;
	cleanup?: () => Promise<void>;
}>;

/**
 * Shared StorageAdapter contract. It asserts on StorageError kinds and
 * returned values only, never on HTTP statuses, so the in-memory and WebDAV
 * adapters stay interchangeable.
 */
export function storageAdapterContract(
	name: string,
	setup: ContractSetup,
): void {
	describe(`StorageAdapter contract: ${name}`, () => {
		let ctx: Awaited<ReturnType<ContractSetup>>;

		beforeEach(async () => {
			ctx = await setup();
		});

		afterEach(async () => {
			await ctx.cleanup?.();
		});

		it("write then read round-trips bytes and stat agrees", async () => {
			const { adapter, path } = ctx;
			const entry = await adapter.write(
				path("f.txt"),
				Buffer.from("synthetic"),
			);
			expect(entry.kind).toBe("file");
			expect(entry.size).toBe(9);
			expect(await adapter.read(path("f.txt"))).toEqual(
				Buffer.from("synthetic"),
			);
			const stat = await adapter.stat(path("f.txt"));
			expect(stat.kind).toBe("file");
			expect(stat.size).toBe(9);
		});
	});
}
