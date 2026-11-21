import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { buildMounts } from "../../src/storage/mounts.ts";
import { WebDavAdapter } from "../../src/storage/webdav-adapter.ts";
import {
	type FakeWebDav,
	startFakeWebDav,
} from "../helpers/fake-webdav-server.ts";

// Anonymised OX App Suite recordings (test/fixtures/ox/) served by the fake
// server as the 207 body. The WebDAV URL is the Userstore folder, the mount
// root is the probe folder, so the recorded hrefs line up with the requests.
const BASE_PATH = "servlet/webdav.infostore/Userstore/Last,%20First/";

let fake: FakeWebDav | undefined;

afterEach(async () => {
	await fake?.close();
	fake = undefined;
});

function fixture(name: string): string {
	return readFileSync(
		new URL(`../fixtures/ox/${name}`, import.meta.url),
		"utf8",
	);
}

async function replay(name: string) {
	const server = await startFakeWebDav();
	fake = server;
	server.script(() => ({
		status: 207,
		headers: { "Content-Type": "application/xml" },
		body: fixture(name),
	}));
	const adapter = new WebDavAdapter({
		url: `${server.url}${BASE_PATH}`,
		username: "u",
		password: "p",
		retry: { minTimeout: 1, maxTimeout: 5 },
	});
	const built = buildMounts({
		t: { path: "/probe-2026-01-01", mode: "read-write" },
	});
	if (!built.ok) throw new Error("expected buildMounts to succeed");
	return { adapter, path: (rel: string) => built.mounts.resolve("t", rel) };
}

describe("OX replay: Depth 0 PROPFIND on a file", () => {
	it("stat of p02.txt returns the recorded file entry", async () => {
		const { adapter, path } = await replay("p02-propfind-depth0-file.xml");
		const entry = await adapter.stat(path("p02.txt"));
		// RED: deliberately wrong placeholders; the diff shows what the adapter returns.
		expect(entry).toEqual({
			name: "p02.txt",
			kind: "file",
			size: -1,
			etag: "PLACEHOLDER",
			lastModified: null,
		});
	});
});
