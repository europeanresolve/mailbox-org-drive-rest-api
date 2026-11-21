import { Writable } from "node:stream";

export interface LogCapture {
	stream: Writable;
	lines(): string[];
}

/** In-memory pino destination for tests that assert on what the app logs. */
export function captureLogs(): LogCapture {
	const chunks: string[] = [];
	const stream = new Writable({
		write(chunk: Buffer | string, _encoding, callback) {
			chunks.push(chunk.toString());
			callback();
		},
	});
	return {
		stream,
		lines: () =>
			chunks
				.join("")
				.split("\n")
				.filter((line) => line.length > 0),
	};
}
