import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ConfigError,
	type ConfigIssue,
	loadConfig,
} from "../../src/config/load.ts";

const ENV = { WEBDAV_APP_PASSWORD: "x" };

function has(issues: readonly ConfigIssue[], code: string, at: string) {
	return issues.some((issue) => issue.code === code && issue.at === at);
}

function loadYaml(text: string, extra: NodeJS.ProcessEnv = {}): ConfigError {
	const dir = mkdtempSync(join(tmpdir(), "snook-mirror-cfg-"));
	try {
		const file = join(dir, "config.yaml");
		writeFileSync(file, text);
		try {
			loadConfig({ CONFIG_FILE: file, ...ENV, ...extra });
		} catch (error) {
			if (error instanceof ConfigError) return error;
			throw error;
		}
		return expect.fail("expected loadConfig to throw");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const base = `
mongo:
  uri: mongodb://127.0.0.1:27017/example
storage:
  webdav:
    url: https://dav.example.invalid/
    username: user@example.invalid
    password: \${WEBDAV_APP_PASSWORD}
mounts:
  forms:
    path: /forms
    mode: read-write
`;

describe("mirror config", () => {
	it("requires mirror when collections exist", () => {
		const error = loadYaml(`${base}
collections:
  contact:
    schema:
      type: object
      additionalProperties: false
      properties:
        name: { type: string, maxLength: 100 }
    operations:
      create: anonymous
`);
		expect(has(error.issues, "mirror.REQUIRED", "/mirror")).toBe(true);
	});

	it("rejects unknown and read mirror mounts and bad timing with collections", () => {
		const error = loadYaml(`${base}
mirror:
  mount: nope
collections:
  contact:
    schema:
      type: object
      additionalProperties: false
      properties:
        name: { type: string, maxLength: 100 }
    operations:
      create: anonymous
`);
		expect(has(error.issues, "mirror.MOUNT_UNKNOWN", "/mirror/mount")).toBe(
			true,
		);
	});

	it("rejects a read mirror mount", () => {
		const error = loadYaml(`
mongo:
  uri: mongodb://127.0.0.1:27017/example
storage:
  webdav:
    url: https://dav.example.invalid/
    username: user@example.invalid
    password: \${WEBDAV_APP_PASSWORD}
mounts:
  forms:
    path: /forms
    mode: read-write
  sheets:
    path: /sheets
    mode: read
mirror:
  mount: sheets
collections:
  contact:
    schema:
      type: object
      additionalProperties: false
      properties:
        name: { type: string, maxLength: 100 }
    operations:
      create: anonymous
`);
		expect(
			has(error.issues, "mirror.MOUNT_NOT_WRITABLE", "/mirror/mount"),
		).toBe(true);
	});

	it("rejects maxWait below debounce", () => {
		const error = loadYaml(`${base}
mirror:
  mount: forms
  debounceSeconds: 60
  maxWaitSeconds: 30
collections:
  contact:
    schema:
      type: object
      additionalProperties: false
      properties:
        name: { type: string, maxLength: 100 }
    operations:
      create: anonymous
`);
		expect(
			has(
				error.issues,
				"mirror.MAX_WAIT_BELOW_DEBOUNCE",
				"/mirror/maxWaitSeconds",
			),
		).toBe(true);
	});

	it("rejects invalid ROLE with other issues in one ConfigError", () => {
		const error = loadYaml(
			`${base}
collections:
  contact:
    schema:
      type: object
      additionalProperties: false
      properties:
        name: { type: string, maxLength: 100 }
    operations:
      create: anonymous
`,
			{ ROLE: "both" },
		);
		expect(has(error.issues, "mirror.REQUIRED", "/mirror")).toBe(true);
		expect(has(error.issues, "env.INVALID_ROLE", "ROLE")).toBe(true);
		expect(JSON.stringify(error.issues)).not.toMatch(/both|forms|nope/i);
	});

	it("loads without mirror when no collections", () => {
		const dir = mkdtempSync(join(tmpdir(), "snook-mirror-cfg-"));
		try {
			const file = join(dir, "config.yaml");
			writeFileSync(file, base);
			const config = loadConfig({ CONFIG_FILE: file, ...ENV });
			expect(config.mirror).toBeUndefined();
			expect(config.role).toBe("all");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accepts mirror without collections and resolves defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "snook-mirror-cfg-"));
		try {
			const file = join(dir, "config.yaml");
			writeFileSync(
				file,
				`${base}
mirror:
  mount: forms
`,
			);
			const config = loadConfig({ CONFIG_FILE: file, ...ENV, ROLE: "worker" });
			expect(config.role).toBe("worker");
			expect(config.mirror).toEqual({
				mount: "forms",
				debounceSeconds: 15,
				maxWaitSeconds: 180,
				reconcileMinutes: 15,
				maxCellLength: 32767,
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("loads a valid mirror with collections", () => {
		const dir = mkdtempSync(join(tmpdir(), "snook-mirror-cfg-"));
		try {
			const file = join(dir, "config.yaml");
			writeFileSync(
				file,
				`${base}
mirror:
  mount: forms
collections:
  contact:
    schema:
      type: object
      additionalProperties: false
      properties:
        name: { type: string, maxLength: 100 }
    operations:
      create: anonymous
`,
			);
			const config = loadConfig({ CONFIG_FILE: file, ...ENV });
			expect(config.mirror?.mount).toBe("forms");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
