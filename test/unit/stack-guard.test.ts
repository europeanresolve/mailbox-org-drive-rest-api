import { describe, expect, it } from "vitest";
import { assertLoopback } from "../integration/global-setup.js";

const REFUSED = "integration tests only run against the local Compose stack";

describe("assertLoopback", () => {
	it("accepts 127.0.0.1, localhost and [::1] targets", () => {
		expect(() =>
			assertLoopback([
				"mongodb://127.0.0.1:27017",
				"http://localhost:6065/",
				"http://[::1]:6065/",
			]),
		).not.toThrow();
	});

	it("refuses a non-loopback WebDAV URL", () => {
		expect(() => assertLoopback(["https://dav.example.invalid/"])).toThrow(
			REFUSED,
		);
	});

	it("refuses a non-loopback MongoDB URI", () => {
		expect(() =>
			assertLoopback(["mongodb://db.example.invalid:27017"]),
		).toThrow(REFUSED);
	});
});
