import { MongoClient } from "mongodb";
import { afterAll, describe, expect, inject, it } from "vitest";
import { STACK } from "./global-setup.js";

const runId = inject("runId");
const client = new MongoClient(STACK.mongoUri, {
	serverSelectionTimeoutMS: 5000,
});

afterAll(async () => {
	await client.close();
});

describe("local Compose stack", () => {
	it("MongoDB round trip", async () => {
		const smoke = client
			.db(`it-${runId}`)
			.collection<{ _id: string; n: number }>("smoke");
		await smoke.insertOne({ _id: "smoke", n: 1 });
		const found = await smoke.findOne({ _id: "smoke" });
		expect(found?.n).toBe(1);
	});

	it("WebDAV round trip", async () => {
		const url = new URL(`run-${runId}/hello.txt`, STACK.webdavUrl);
		const auth = `Basic ${Buffer.from(`${STACK.webdavUser}:${STACK.webdavPassword}`).toString("base64")}`;
		const body = "synthetic smoke file";

		const put = await fetch(url, {
			method: "PUT",
			headers: { Authorization: auth },
			body,
		});
		expect(put.ok).toBe(true);

		const get = await fetch(url, { headers: { Authorization: auth } });
		expect(get.ok).toBe(true);
		expect(await get.text()).toBe(body);
	});
});
