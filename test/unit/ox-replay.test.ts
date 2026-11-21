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

/** First text of an element, read from the fixture XML itself. */
function textOf(xml: string, element: string): string {
	const match = new RegExp(`<D:${element}[^>]*>([^<]*)</D:${element}>`).exec(
		xml,
	);
	if (match?.[1] === undefined) throw new Error(`fixture has no ${element}`);
	return match[1];
}

describe("OX replay: Depth 0 PROPFIND on a file", () => {
	it("stat of p02.txt returns the recorded size and ETag", async () => {
		const { adapter, path } = await replay("p02-propfind-depth0-file.xml");
		const xml = fixture("p02-propfind-depth0-file.xml");
		const entry = await adapter.stat(path("p02.txt"));
		expect(entry).toMatchObject({
			name: "p02.txt",
			kind: "file",
			size: Number(textOf(xml, "getcontentlength")),
			// OX sends the ETag unquoted; the client hands the string back as is.
			etag: textOf(xml, "getetag").replace(/^"|"$/g, ""),
		});
		// C-1: OX tags getlastmodified with b:dt; the adapter reads the text.
		expect(entry.lastModified).toEqual(
			new Date(textOf(xml, "getlastmodified")),
		);
	});
});

describe("OX replay: Depth 0 PROPFIND on a folder", () => {
	it("stat of the probe folder returns kind dir", async () => {
		const { adapter, path } = await replay("p02-propfind-depth0-folder.xml");
		const xml = fixture("p02-propfind-depth0-folder.xml");
		expect(xml).toContain("<D:collection />");
		const entry = await adapter.stat(path(""));
		expect(entry.kind).toBe("dir");
		expect(entry.size).toBe(0);
	});
});

/** Decoded last segment of every href in the fixture except the folder's own. */
function listedNames(xml: string): string[] {
	const hrefs = [...xml.matchAll(/<D:href>([^<]*)<\/D:href>/g)].map(
		(m) => m[1] ?? "",
	);
	return hrefs
		.filter((href) => !href.endsWith("/"))
		.map((href) => decodeURIComponent(href.slice(href.lastIndexOf("/") + 1)));
}

describe("OX replay: Depth 1 listing with special names", () => {
	it("list returns every synthetic name decoded, without the folder itself", async () => {
		const { adapter, path } = await replay("p03-propfind-depth1-names.xml");
		const expected = listedNames(fixture("p03-propfind-depth1-names.xml"));
		// The names P-03 created: comma-space, ampersand, hash, percent, plus,
		// NFC and NFD Müller, emoji, plus the P-02 file.
		expect(expected).toHaveLength(9);
		expect(expected).toContain("Last, First.txt");
		expect(expected).toContain("pct%41.txt");
		expect(expected).toContain("emoji-\u{1F600}.txt");
		expect(expected).toContain("M\u00fcller.txt");
		expect(expected).toContain("Mu\u0308ller.txt");
		const entries = await adapter.list(path(""));
		const names = entries.map((e) => e.name);
		// OX lists in no particular order; the adapter sorts in code-unit order.
		expect(names).toEqual([...expected].sort());
		expect(names).not.toContain("probe-2026-01-01");
		expect(entries.every((e) => e.kind === "file")).toBe(true);
	});
});
