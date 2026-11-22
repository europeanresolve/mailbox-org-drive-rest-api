import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import {
	ConfigError,
	type ConfigIssue,
	loadConfig,
} from "../../src/config/load.ts";
import { start } from "../../src/server.ts";
import { captureLogs } from "../helpers/log-capture.ts";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "config");
const SCRATCH = mkdtempSync(join(tmpdir(), "snook-config-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

const CANARY = "canary-7f3a";

let counter = 0;
function write(text: string, name = `c${counter++}.yaml`): string {
	const path = join(SCRATCH, name);
	mkdirSync(SCRATCH, { recursive: true });
	writeFileSync(path, text);
	return path;
}

type Parts = {
	server: string;
	mongoUri: string;
	url: string;
	password: string;
	mounts: string;
};

const FORMS =
	"  forms:\n    path: /Userstore/Example Service/Forms\n    mode: read-write\n";

/** A valid config as text; each part can be replaced to break one thing. */
function yamlConfig(overrides: Partial<Parts> = {}): string {
	const p: Parts = {
		server: "",
		mongoUri: "mongodb://127.0.0.1:27017/example",
		url: "https://dav.example.invalid/",
		password: `\${WEBDAV_APP_PASSWORD}`,
		mounts: FORMS,
		...overrides,
	};
	return `${p.server}mongo:
  uri: ${p.mongoUri}
storage:
  webdav:
    url: ${p.url}
    username: user@example.invalid
    password: ${p.password}
mounts:
${p.mounts}`;
}

const PASSWORD_ENV = { WEBDAV_APP_PASSWORD: "x" };

function envFor(text: string, extra: NodeJS.ProcessEnv = PASSWORD_ENV) {
	return { CONFIG_FILE: write(text), ...extra };
}

function failure(env: NodeJS.ProcessEnv): ConfigError {
	try {
		loadConfig(env);
	} catch (error) {
		if (error instanceof ConfigError) return error;
		throw error;
	}
	return expect.fail("expected loadConfig to throw a ConfigError");
}

function has(issues: readonly ConfigIssue[], code: string, at?: string) {
	return issues.some(
		(issue) => issue.code === code && (at === undefined || issue.at === at),
	);
}

/** toEqual with a one-line failure message, so reports stay machine-parseable. */
function eq(actual: unknown) {
	return {
		toEqual(expected: unknown): void {
			expect(
				isDeepStrictEqual(actual, expected),
				`got ${JSON.stringify(actual)}`,
			).toBe(true);
		},
	};
}

function codes(issues: readonly ConfigIssue[]): string[] {
	return issues.map((issue) => issue.code);
}

describe("loadConfig: one failure for a bad config file", () => {
	const invalidMany = () =>
		failure({ CONFIG_FILE: join(FIXTURES, "invalid-many.yaml") });

	it("reports an unknown top-level key", () => {
		expect(
			has(invalidMany().issues, "schema.additionalProperties", "/extra"),
		).toBe(true);
	});

	it("reports a mount name outside the allowed pattern", () => {
		expect(
			has(
				invalidMany().issues,
				"schema.additionalProperties",
				"/mounts/Bad_Name",
			),
		).toBe(true);
	});

	it("reports a missing required block by name", () => {
		expect(has(invalidMany().issues, "schema.required", "/mongo")).toBe(true);
	});

	it("reports an insecure WebDAV URL", () => {
		expect(
			has(invalidMany().issues, "storage.INSECURE_URL", "/storage/webdav/url"),
		).toBe(true);
	});

	it("never echoes a config value", () => {
		const error = invalidMany();
		expect(JSON.stringify(error.issues) + error.message).not.toMatch(
			/canary-7f3a|dav\.example\.invalid|user@example/i,
		);
	});
});

describe("loadConfig: file and YAML", () => {
	it("a missing file gives only file.UNREADABLE at the path", () => {
		const path = join(SCRATCH, "does-not-exist.yaml");
		eq(failure({ CONFIG_FILE: path }).issues).toEqual([
			{ code: "file.UNREADABLE", at: path },
		]);
	});

	it("a duplicate key and bad indentation give yaml issues with line and col, in position order", () => {
		const text = `mongo:
  uri: x
storage:
  webdav:
    password: ${CANARY}-one
    password: ${CANARY}-two
 oops: indent
`;
		const { issues, message } = failure({ CONFIG_FILE: write(text) });
		expect(issues[0]?.code).toBe("yaml.DUPLICATE_KEY");
		expect(issues[0]?.line).toBe(6);
		expect(issues.length).toBeGreaterThanOrEqual(2);
		for (const issue of issues) {
			expect(issue.code).toMatch(/^yaml\./);
			expect(typeof issue.line).toBe("number");
			expect(typeof issue.col).toBe("number");
		}
		const positions = issues.map((i) => (i.line ?? 0) * 1000 + (i.col ?? 0));
		eq(positions).toEqual([...positions].sort((a, b) => a - b));
		expect(new Set(issues.map((i) => JSON.stringify(i))).size).toBe(
			issues.length,
		);
		expect(JSON.stringify(issues) + message).not.toContain(CANARY);
	});

	it.each([
		["an empty file", ""],
		["a comments-only file", "# nothing here\n# at all\n"],
	])("%s lists every missing required top-level field", (_name, text) => {
		const { issues } = failure({ CONFIG_FILE: write(text) });
		eq(issues).toEqual([
			{ code: "schema.required", at: "/mongo" },
			{ code: "schema.required", at: "/storage" },
			{ code: "schema.required", at: "/mounts" },
		]);
	});
});

describe("loadConfig: NAME and NAME_FILE placeholders", () => {
	const passwordOf = (env: NodeJS.ProcessEnv) =>
		loadConfig(env).storage.webdav.password;

	it("resolves from the environment", () => {
		expect(passwordOf(envFor(yamlConfig()))).toBe("x");
	});

	it("resolves from NAME_FILE, trimming a trailing newline, to a deep-equal Config", () => {
		const file = write("x\n", "secret.txt");
		const config = write(yamlConfig());
		const fromEnv = loadConfig({ CONFIG_FILE: config, ...PASSWORD_ENV });
		const fromFile = loadConfig({
			CONFIG_FILE: config,
			WEBDAV_APP_PASSWORD_FILE: file,
		});
		eq(fromFile).toEqual(fromEnv);
		const crlf = write("x\r\n", "secret-crlf.txt");
		expect(
			passwordOf({ CONFIG_FILE: config, WEBDAV_APP_PASSWORD_FILE: crlf }),
		).toBe("x");
	});

	it("reports env.BOTH_SET naming the variable when both sources are set", () => {
		const file = write("x\n", "secret.txt");
		const { issues } = failure(
			envFor(yamlConfig(), {
				WEBDAV_APP_PASSWORD: "x",
				WEBDAV_APP_PASSWORD_FILE: file,
			}),
		);
		expect(issues).toContainEqual({
			code: "env.BOTH_SET",
			at: "WEBDAV_APP_PASSWORD",
		});
	});

	it("reports env.MISSING when neither source is set", () => {
		const { issues } = failure(envFor(yamlConfig(), {}));
		expect(issues).toContainEqual({
			code: "env.MISSING",
			at: "WEBDAV_APP_PASSWORD",
		});
	});

	it("reports env.FILE_UNREADABLE for an unreadable NAME_FILE", () => {
		const { issues } = failure(
			envFor(yamlConfig(), {
				WEBDAV_APP_PASSWORD_FILE: join(SCRATCH, "no-such-secret"),
			}),
		);
		expect(issues).toContainEqual({
			code: "env.FILE_UNREADABLE",
			at: "WEBDAV_APP_PASSWORD",
		});
	});

	it.each([
		[
			"both set",
			() => ({
				WEBDAV_APP_PASSWORD: "x",
				WEBDAV_APP_PASSWORD_FILE: write("x", "s1"),
			}),
		],
		["missing", () => ({})],
		[
			"unreadable file",
			() => ({ WEBDAV_APP_PASSWORD_FILE: join(SCRATCH, "nope") }),
		],
	])(
		"a failed placeholder (%s) adds no second issue for that field",
		(_name, extra) => {
			const { issues } = failure(envFor(yamlConfig(), extra()));
			eq(
				issues.filter((i) => i.at?.startsWith("/storage/webdav/password")),
			).toEqual([]);
			expect(issues).toHaveLength(1);
		},
	);

	it("a failed placeholder in the URL or a mount path adds no schema or semantic issue", () => {
		const { issues } = failure(
			envFor(
				yamlConfig({
					url: `\${WEBDAV_URL}`,
					mounts: `  forms:\n    path: \${FORMS_PATH}\n    mode: read-write\n`,
				}),
			),
		);
		eq(codes(issues)).toEqual(["env.MISSING", "env.MISSING"]);
	});

	it.each([
		["a lowercase name", `\${lower}`],
		["an unterminated placeholder", `abc\${`],
		["an empty placeholder", `\${}`],
	])("%s gives env.INVALID_PLACEHOLDER at the JSON pointer", (_name, value) => {
		const { issues } = failure(envFor(yamlConfig({ password: value })));
		eq(issues).toEqual([
			{ code: "env.INVALID_PLACEHOLDER", at: "/storage/webdav/password" },
		]);
	});

	it("resolves a placeholder embedded in a larger value", () => {
		const text = yamlConfig({
			mongoUri: `mongodb://u:\${MONGO_PASSWORD}@127.0.0.1:27017/x`,
		});
		const config = loadConfig(
			envFor(text, { ...PASSWORD_ENV, MONGO_PASSWORD: "pw" }),
		);
		expect(config.mongo.uri).toBe("mongodb://u:pw@127.0.0.1:27017/x");
	});

	it("keeps an env value that looks like YAML as a literal string", () => {
		expect(
			passwordOf(envFor(yamlConfig(), { WEBDAV_APP_PASSWORD: "a: [b, {c" })),
		).toBe("a: [b, {c");
	});
});

describe("loadConfig: PORT and LOG_LEVEL overrides", () => {
	const text = yamlConfig({
		server: "server:\n  port: 4000\n  logLevel: warn\n",
	});

	it("PORT and LOG_LEVEL override the file", () => {
		const config = loadConfig(
			envFor(text, { ...PASSWORD_ENV, PORT: "8080", LOG_LEVEL: "debug" }),
		);
		eq(config.server).toEqual({
			port: 8080,
			logLevel: "debug",
			trustProxy: [],
		});
	});

	it("without overrides the file value is kept", () => {
		eq(loadConfig(envFor(text)).server).toEqual({
			port: 4000,
			logLevel: "warn",
			trustProxy: [],
		});
	});

	it.each(["abc", "70000", "-1", "80.5", ""])(
		"PORT=%j gives env.INVALID_PORT",
		(port) => {
			const { issues } = failure(envFor(text, { ...PASSWORD_ENV, PORT: port }));
			eq(issues).toEqual([{ code: "env.INVALID_PORT", at: "PORT" }]);
		},
	);

	it("LOG_LEVEL=loud gives env.INVALID_LOG_LEVEL", () => {
		const { issues } = failure(
			envFor(text, { ...PASSWORD_ENV, LOG_LEVEL: "loud" }),
		);
		eq(issues).toEqual([{ code: "env.INVALID_LOG_LEVEL", at: "LOG_LEVEL" }]);
	});

	it("mounts come only from the file, never from the environment", () => {
		const config = loadConfig(
			envFor(yamlConfig(), {
				...PASSWORD_ENV,
				MOUNTS: "x",
				MOUNTS_FORMS_PATH: "/x",
			}),
		);
		eq(Object.keys(config.mounts)).toEqual(["forms"]);
	});
});

describe("loadConfig: schema and semantic checks in one failure", () => {
	it("an empty mounts map gives schema.minProperties", () => {
		const { issues } = failure(envFor(yamlConfig({ mounts: "  {}\n" })));
		eq(issues).toEqual([{ code: "schema.minProperties", at: "/mounts" }]);
	});

	it("unknown keys are rejected at every level", () => {
		const text = `${yamlConfig({ server: "server:\n  port: 1\n  nope: 1\n" })}`;
		const { issues } = failure(envFor(text));
		expect(issues).toContainEqual({
			code: "schema.additionalProperties",
			at: "/server/nope",
		});
	});

	it("nested read-write mounts give mount.OVERLAP alongside schema issues", () => {
		const mounts = `${FORMS}  inner:
    path: /Userstore/Example Service/Forms/Inner
    mode: read-write
`;
		const { issues } = failure(envFor(`extra: 1\n${yamlConfig({ mounts })}`));
		expect(has(issues, "mount.OVERLAP")).toBe(true);
		expect(has(issues, "schema.additionalProperties", "/extra")).toBe(true);
	});

	it("a mount at the Drive root gives mount.AT_ROOT", () => {
		const { issues } = failure(
			envFor(yamlConfig({ mounts: "  top:\n    path: /\n    mode: read\n" })),
		);
		eq(issues).toEqual([{ code: "mount.AT_ROOT", at: "/mounts/top" }]);
	});

	it.each([
		"https://dav.example.invalid/",
		"http://127.0.0.1:6065/",
		"http://localhost:6065/",
		"http://[::1]:6065/",
	])("accepts the WebDAV URL %s", (url) => {
		expect(loadConfig(envFor(yamlConfig({ url }))).storage.webdav.url).toBe(
			url,
		);
	});

	it("rejects an http URL to a remote host", () => {
		const { issues } = failure(
			envFor(yamlConfig({ url: "http://dav.example.invalid/" })),
		);
		eq(issues).toEqual([
			{ code: "storage.INSECURE_URL", at: "/storage/webdav/url" },
		]);
	});

	it("rejects a string that is not a URL", () => {
		const { issues } = failure(envFor(yamlConfig({ url: "'not a url'" })));
		eq(issues).toEqual([
			{ code: "storage.INVALID_URL", at: "/storage/webdav/url" },
		]);
	});
});

describe("loadConfig: stable ordering", () => {
	// env issue (missing password), schema issues out of schema order, semantic issue last.
	// Schema errors come out of Ajv in schema order; the file puts them the other way round.
	const text = `mounts: {}
mongo:
  uri: x
storage:
  webdav:
    url: http://dav.example.invalid/
    username: user@example.invalid
    password: \${WEBDAV_APP_PASSWORD}
extra: 1
`;

	it("orders issues file, yaml, env, schema, semantic, each in document order", () => {
		const { issues } = failure(envFor(text, {}));
		eq(issues.map((i) => `${i.code} ${i.at}`)).toEqual([
			"env.MISSING WEBDAV_APP_PASSWORD",
			"schema.minProperties /mounts",
			"schema.additionalProperties /extra",
			"storage.INSECURE_URL /storage/webdav/url",
		]);
	});

	it("prints identical issues for two runs on the same input", () => {
		const env = envFor(text, {});
		expect(JSON.stringify(failure(env).issues)).toBe(
			JSON.stringify(failure(env).issues),
		);
	});
});

describe("loadConfig: result", () => {
	const valid = () =>
		loadConfig({
			CONFIG_FILE: join(FIXTURES, "valid.yaml"),
			...PASSWORD_ENV,
		});

	it("fills defaults", () => {
		const config = valid();
		eq(config.server).toEqual({ port: 3000, logLevel: "info", trustProxy: [] });
		expect(config.storage.webdav.concurrency).toBe(2);
		eq(Object.keys(config.mounts)).toEqual(["forms", "content"]);
	});

	it("is deeply frozen", () => {
		const config = valid() as unknown as {
			mounts: { forms: { mode: string } };
			server: { port: number };
		};
		expect(() => {
			config.mounts.forms.mode = "read";
		}).toThrow(TypeError);
		expect(() => {
			config.server.port = 1;
		}).toThrow(TypeError);
		expect(Object.isFrozen(config)).toBe(true);
	});
});

describe("loadConfig: no value is ever echoed", () => {
	const cases: Record<string, () => NodeJS.ProcessEnv> = {
		"secret value in a schema-invalid file": () => ({
			CONFIG_FILE: join(FIXTURES, "invalid-many.yaml"),
		}),
		"secret on a duplicated YAML line": () => ({
			CONFIG_FILE: write(
				`mongo:\n  uri: ${CANARY}-1\n  uri: ${CANARY}-2\n bad: ${CANARY}\n`,
			),
		}),
		"canary as an env secret with both sources set": () =>
			envFor(yamlConfig(), {
				WEBDAV_APP_PASSWORD: `${CANARY}-env`,
				WEBDAV_APP_PASSWORD_FILE: write(`${CANARY}-file`, "canary-file"),
			}),
		"canary as an invalid PORT": () =>
			envFor(yamlConfig(), { ...PASSWORD_ENV, PORT: CANARY }),
		"canary as an invalid LOG_LEVEL": () =>
			envFor(yamlConfig(), { ...PASSWORD_ENV, LOG_LEVEL: CANARY }),
		"canary inside a malformed placeholder": () =>
			envFor(yamlConfig({ password: `\${${CANARY}` })),
		"canary as a bad URL": () => envFor(yamlConfig({ url: `"${CANARY}"` })),
		"canary as an invalid mount mode": () =>
			envFor(
				yamlConfig({
					mounts: `  a:\n    path: /Userstore/Example Service/A\n    mode: ${CANARY}\n`,
				}),
			),
		"canary as an env value for an unreadable file": () =>
			envFor(yamlConfig(), {
				WEBDAV_APP_PASSWORD_FILE: `/nonexistent/${CANARY}`,
			}),
	};

	it.each(Object.keys(cases))("%s", (name) => {
		const error = failure((cases[name] as () => NodeJS.ProcessEnv)());
		expect(JSON.stringify(error.issues) + error.message).not.toMatch(
			new RegExp(CANARY, "i"),
		);
	});
});

describe("deployer example config", () => {
	it("loads cleanly once its environment variables are set", () => {
		const config = loadConfig({
			CONFIG_FILE: join(
				import.meta.dirname,
				"..",
				"..",
				"config",
				"config.example.yaml",
			),
			MONGO_URI: "mongodb://127.0.0.1:27017/example",
			WEBDAV_URL: "https://dav.example.invalid/",
			WEBDAV_USERNAME: "user@example.invalid",
			WEBDAV_APP_PASSWORD: "synthetic-password",
		});
		eq(Object.keys(config.mounts)).toEqual(["forms", "content"]);
		expect(config.mounts.forms?.mode).toBe("read-write");
		expect(config.mounts.content?.mode).toBe("read");
	});
});

describe("start with a valid config", () => {
	it("listens, answers /health and logs mount names and modes but never paths", async () => {
		const forms = readFileSync(join(FIXTURES, "valid.yaml"), "utf8").replace(
			"/Userstore/Example Service/Forms",
			"/Userstore/CANARY-7f3a Last, First/Forms",
		);
		const logs = captureLogs();
		const { app, close } = await start({
			env: { CONFIG_FILE: write(forms), ...PASSWORD_ENV, PORT: "0" },
			logStream: logs.stream,
		});
		try {
			const res = await app.inject({ method: "GET", url: "/health" });
			expect(res.statusCode).toBe(200);
			const lines = logs.lines();
			const loaded = lines
				.map((line) => JSON.parse(line) as Record<string, unknown>)
				.find((entry) => entry.msg === "configuration loaded");
			eq(loaded?.mounts).toEqual([
				{ name: "forms", mode: "read-write" },
				{ name: "content", mode: "read" },
			]);
			for (const line of lines) {
				expect(line).not.toMatch(/canary-7f3a|Userstore|Last, First/i);
			}
		} finally {
			await close();
		}
	});
});
