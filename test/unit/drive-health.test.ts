import { describe, expect, it } from "vitest";
import { createDriveHealth } from "../../src/storage/drive-health.ts";
import { StorageError } from "../../src/storage/errors.ts";

type Deferred = {
	promise: Promise<unknown>;
	resolve(): void;
	reject(error: unknown): void;
};

function deferred(): Deferred {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<unknown>((res, rej) => {
		resolve = () => res(undefined);
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** A probe whose every call can be settled by the test. */
function controlledProbe() {
	const calls: Deferred[] = [];
	return {
		calls,
		probe: () => {
			const next = deferred();
			calls.push(next);
			return next.promise;
		},
	};
}

async function flush(): Promise<void> {
	await new Promise((resolve) => setImmediate(resolve));
}

describe("createDriveHealth", () => {
	it("returns unknown on the first call and starts exactly one probe", () => {
		const { probe, calls } = controlledProbe();
		const health = createDriveHealth({ probe });
		expect(health.state()).toBe("unknown");
		expect(calls).toHaveLength(1);
	});

	it("reports up once the probe has resolved", async () => {
		const { probe, calls } = controlledProbe();
		const health = createDriveHealth({ probe });
		health.state();
		calls[0]?.resolve();
		await flush();
		expect(health.state()).toBe("up");
	});

	it("maps a rate-limited StorageError to degraded", async () => {
		const { probe, calls } = controlledProbe();
		const health = createDriveHealth({ probe });
		health.state();
		calls[0]?.reject(new StorageError("rate-limited", "stat", 429));
		await flush();
		expect(health.state()).toBe("degraded");
	});

	it.each([
		["a StorageError of another kind", new StorageError("unavailable", "stat")],
		["an unauthorized StorageError", new StorageError("unauthorized", "stat")],
		["a plain Error", new Error("boom")],
		["a non-Error rejection", "boom"],
	])("maps %s to unavailable", async (_name, error) => {
		const { probe, calls } = controlledProbe();
		const health = createDriveHealth({ probe });
		health.state();
		calls[0]?.reject(error);
		await flush();
		expect(health.state()).toBe("unavailable");
	});

	it("treats a probe that throws synchronously as unavailable", async () => {
		const health = createDriveHealth({
			probe: () => {
				throw new Error("sync");
			},
		});
		expect(health.state()).toBe("unknown");
		await flush();
		expect(health.state()).toBe("unavailable");
	});

	it("starts no second probe while one is in flight", () => {
		const { probe, calls } = controlledProbe();
		const health = createDriveHealth({ probe });
		for (let i = 0; i < 5; i++) health.state();
		expect(calls).toHaveLength(1);
	});

	it("serves the cached value within ttlMs and refreshes once after it", async () => {
		const { probe, calls } = controlledProbe();
		let clock = 1_000;
		const health = createDriveHealth({
			probe,
			ttlMs: 30_000,
			now: () => clock,
		});
		health.state();
		calls[0]?.resolve();
		await flush();

		clock += 29_999;
		expect(health.state()).toBe("up");
		expect(calls).toHaveLength(1);

		clock += 1;
		expect(health.state()).toBe("up");
		expect(calls).toHaveLength(2);
		// The refresh is in flight: no further probe, and the cache keeps serving.
		expect(health.state()).toBe("up");
		expect(calls).toHaveLength(2);

		calls[1]?.reject(new Error("drive went away"));
		await flush();
		expect(health.state()).toBe("unavailable");
		expect(calls).toHaveLength(2);
	});

	it("defaults the ttl to 30 s", async () => {
		const { probe, calls } = controlledProbe();
		let clock = 0;
		const health = createDriveHealth({ probe, now: () => clock });
		health.state();
		calls[0]?.resolve();
		await flush();
		clock += 29_999;
		health.state();
		expect(calls).toHaveLength(1);
		clock += 1;
		health.state();
		expect(calls).toHaveLength(2);
	});

	it("logs a state change once and never repeats the same state", async () => {
		const { probe, calls } = controlledProbe();
		const logged: { fields: Record<string, unknown>; msg: string }[] = [];
		let clock = 0;
		const health = createDriveHealth({
			probe,
			ttlMs: 10,
			now: () => clock,
			log: {
				warn: (fields: Record<string, unknown>, msg: string) => {
					logged.push({ fields, msg });
				},
			},
		});
		const error = new StorageError("unavailable", "stat");

		health.state();
		calls[0]?.reject(error);
		await flush();
		expect(logged).toHaveLength(1);
		expect(logged[0]?.msg).toBe("drive state changed");
		expect(logged[0]?.fields.drive).toBe("unavailable");
		expect(logged[0]?.fields.err).toBe(error);

		// Same state again: no new line.
		clock += 10;
		health.state();
		calls[1]?.reject(error);
		await flush();
		expect(logged).toHaveLength(1);

		// Recovery is a change and is logged once, without an err.
		clock += 10;
		health.state();
		calls[2]?.resolve();
		await flush();
		expect(logged).toHaveLength(2);
		expect(logged[1]?.fields).toEqual({ drive: "up" });
	});
});
