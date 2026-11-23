import ExcelJS from "exceljs";
import { STACK } from "../integration/global-setup.ts";

function authHeader(): string {
	const raw = `${STACK.webdavUser}:${STACK.webdavPassword}`;
	return `Basic ${Buffer.from(raw).toString("base64")}`;
}

/** WebDAV URL for a path under the stack root; never log the returned URL (credentials). */
export function mirrorUrl(folder: string, rel: string): URL {
	const path = rel.length === 0 ? folder : `${folder}/${rel}`;
	return new URL(
		`.${path.startsWith("/") ? path : `/${path}`}`,
		STACK.webdavUrl,
	);
}

export async function fetchMirror(
	folder: string,
	rel: string,
): Promise<Buffer | null> {
	const res = await fetch(mirrorUrl(folder, rel), {
		method: "GET",
		headers: { Authorization: authHeader() },
	});
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`mirror GET failed with status ${res.status}`);
	}
	return Buffer.from(await res.arrayBuffer());
}

export async function mirrorEtag(
	folder: string,
	rel: string,
): Promise<string | null> {
	const res = await fetch(mirrorUrl(folder, rel), {
		method: "PROPFIND",
		headers: { Authorization: authHeader(), Depth: "0" },
	});
	if (res.status === 404) return null;
	if (!res.ok) {
		throw new Error(`mirror PROPFIND failed with status ${res.status}`);
	}
	const text = await res.text();
	const match = text.match(
		/<(?:[A-Za-z]+:)?getetag>([^<]*)<\/(?:[A-Za-z]+:)?getetag>/,
	);
	const raw = match?.[1]?.trim();
	if (raw === undefined || raw.length === 0) return null;
	return raw.replace(/^"|"$/g, "");
}

export async function listMirror(folder: string, rel = ""): Promise<string[]> {
	const base = rel.length === 0 ? folder : `${folder}/${rel}`;
	const res = await fetch(mirrorUrl(folder, rel), {
		method: "PROPFIND",
		headers: { Authorization: authHeader(), Depth: "1" },
	});
	if (!res.ok) {
		throw new Error(`mirror list failed with status ${res.status}`);
	}
	const text = await res.text();
	const hrefs = [...text.matchAll(/<D:href>([^<]+)<\/D:href>/g)].map((m) =>
		decodeURIComponent(m[1] ?? ""),
	);
	const prefix = new URL(`.${base}/`, STACK.webdavUrl).pathname;
	return hrefs
		.filter((href) => href !== prefix && href.startsWith(prefix))
		.map((href) => href.slice(prefix.length).replace(/\/$/, ""));
}

export async function putMirrorRaw(
	folder: string,
	rel: string,
	bytes: Buffer,
): Promise<void> {
	const res = await fetch(mirrorUrl(folder, rel), {
		method: "PUT",
		headers: { Authorization: authHeader() },
		body: bytes,
	});
	if (!res.ok) {
		throw new Error(`mirror PUT failed with status ${res.status}`);
	}
}

export async function deleteMirror(folder: string, rel: string): Promise<void> {
	const res = await fetch(mirrorUrl(folder, rel), {
		method: "DELETE",
		headers: { Authorization: authHeader() },
	});
	if (![200, 204, 404].includes(res.status)) {
		throw new Error(`mirror DELETE failed with status ${res.status}`);
	}
}

export type MirrorCell = {
	value: unknown;
	type: ExcelJS.ValueType;
	formula?: string;
	hyperlink?: string;
};

export async function readRows(
	buffer: Buffer,
	sheetName?: string,
): Promise<{ sheet: string; rows: unknown[][]; cells: MirrorCell[][] }> {
	const workbook = new ExcelJS.Workbook();
	await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
	const sheet =
		sheetName === undefined
			? workbook.worksheets[0]
			: workbook.getWorksheet(sheetName);
	if (sheet === undefined) {
		throw new Error("workbook has no matching worksheet");
	}
	const rows: unknown[][] = [];
	const cells: MirrorCell[][] = [];
	sheet.eachRow((row) => {
		const values: unknown[] = [];
		const rowCells: MirrorCell[] = [];
		row.eachCell({ includeEmpty: true }, (cell, col) => {
			const raw = cell.value;
			const value =
				raw !== null &&
				typeof raw === "object" &&
				"result" in raw &&
				typeof (raw as { formula?: string }).formula === "string"
					? (raw as { result: unknown }).result
					: raw;
			values[col - 1] = value;
			rowCells[col - 1] = {
				value,
				type: cell.type,
				...(cell.formula === undefined ? {} : { formula: cell.formula }),
				...(cell.hyperlink === undefined
					? {}
					: { hyperlink: String(cell.hyperlink) }),
			};
		});
		rows.push(values);
		cells.push(rowCells);
	});
	return { sheet: sheet.name, rows, cells };
}

export async function waitUntil(
	check: () => boolean | Promise<boolean>,
	timeoutMs: number,
	stepMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() >= deadline) {
			throw new Error(`waitUntil timed out after ${timeoutMs} ms`);
		}
		await new Promise((resolve) => setTimeout(resolve, stepMs));
	}
}
