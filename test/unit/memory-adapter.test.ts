import { describe, expect, it } from "vitest";
import { MemoryAdapter } from "../../src/storage/memory-adapter.ts";
import { openMount } from "../../src/storage/mount-view.ts";
import { buildMounts, type Mounts } from "../../src/storage/mounts.ts";
import {
	type ContractSetup,
	storageAdapterContract,
} from "../contract/storage-adapter.contract.ts";

function testMounts(): Mounts {
	const built = buildMounts({ t: { path: "/c", mode: "read-write" } });
	if (!built.ok) throw new Error("expected buildMounts to succeed");
	return built.mounts;
}

const setup: ContractSetup = async () => {
	const mounts = testMounts();
	const adapter = new MemoryAdapter();
	await adapter.mkdir(mounts.resolve("t", ""));
	return { adapter, path: (rel) => mounts.resolve("t", rel) };
};

storageAdapterContract("memory", setup);

describe("MountView on MemoryAdapter (tracer)", () => {
	it("round-trips bytes through a read-write mount", async () => {
		const mounts = testMounts();
		const adapter = new MemoryAdapter();
		await adapter.mkdir(mounts.resolve("t", ""));
		const mount = openMount(mounts, adapter, "t");
		if (mount.mode !== "read-write") throw new Error("expected read-write");
		await mount.write("f.txt", Buffer.from("synthetic"));
		expect(await mount.read("f.txt")).toEqual(Buffer.from("synthetic"));
	});
});
