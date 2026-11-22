import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { type Document, isNode, parseDocument } from "yaml";
import {
	apiKeyIssues,
	collectionIssues,
	resolveSchemaRefs,
} from "../collections/definition.ts";
import {
	buildMounts,
	type MountDef,
	type MountMode,
} from "../storage/mounts.ts";
import {
	type Config,
	ConfigSchema,
	DEFAULT_BODY_LIMIT,
	LOG_LEVELS,
	MOUNT_NAME_PATTERN,
} from "./schema.ts";

export type ConfigIssue = {
	code: string;
	at?: string;
	line?: number;
	col?: number;
};

/** Carries issue codes and locations only; never a config value (T-01-16). */
export class ConfigError extends Error {
	readonly issues: readonly ConfigIssue[];

	constructor(issues: readonly ConfigIssue[]) {
		super(`invalid configuration: ${issues.length} issue(s)`);
		this.name = "ConfigError";
		this.issues = issues;
	}
}

const DEFAULT_CONFIG_FILE = "config/config.yaml";
const MOUNT_NAME = new RegExp(MOUNT_NAME_PATTERN);
const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
	ConfigSchema,
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(segment: string | number): string {
	return `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

/** An issue list that drops exact duplicates, keeping first-seen order. */
function collector() {
	const seen = new Set<string>();
	const issues: ConfigIssue[] = [];
	return {
		issues,
		add(issue: ConfigIssue): void {
			const key = JSON.stringify(issue);
			if (seen.has(key)) return;
			seen.add(key);
			issues.push(issue);
		},
	};
}

type Collector = ReturnType<typeof collector>;

// --- stage 2: YAML -----------------------------------------------------------

function yamlIssues(doc: Document.Parsed): ConfigIssue[] {
	const found = collector();
	const ordered = [...doc.errors].sort((a, b) => a.pos[0] - b.pos[0]);
	for (const error of ordered) {
		const start = error.linePos?.[0];
		// Never error.message: it embeds the offending source line (Pitfall 2).
		found.add({
			code: `yaml.${error.code}`,
			...(start ? { line: start.line, col: start.col } : {}),
		});
	}
	return found.issues;
}

// --- stage 3: ${NAME} placeholders -------------------------------------------

function resolveVariable(
	name: string,
	env: NodeJS.ProcessEnv,
	report: (code: string) => void,
): string | undefined {
	const direct = env[name];
	const filePath = env[`${name}_FILE`];
	if (direct !== undefined && filePath !== undefined) {
		report("env.BOTH_SET");
		return undefined;
	}
	if (direct !== undefined) return direct;
	if (filePath === undefined) {
		report("env.MISSING");
		return undefined;
	}
	try {
		return readFileSync(filePath, "utf8").replace(/\r?\n$/, "");
	} catch {
		report("env.FILE_UNREADABLE");
		return undefined;
	}
}

/** Resolves every placeholder in one string value; undefined if any failed. */
function interpolateString(
	value: string,
	at: string,
	env: NodeJS.ProcessEnv,
	found: Collector,
): string | undefined {
	let out = "";
	let failed = false;
	let i = 0;
	while (i < value.length) {
		const start = value.indexOf("${", i);
		if (start === -1) {
			out += value.slice(i);
			break;
		}
		out += value.slice(i, start);
		const end = value.indexOf("}", start + 2);
		const name = end === -1 ? "" : value.slice(start + 2, end);
		if (!VARIABLE_NAME.test(name)) {
			found.add({ code: "env.INVALID_PLACEHOLDER", at });
			return undefined;
		}
		const resolved = resolveVariable(name, env, (code) =>
			found.add({ code, at: name }),
		);
		if (resolved === undefined) failed = true;
		else out += resolved;
		i = end + 1;
	}
	return failed ? undefined : out;
}

/**
 * Walks parsed values only, so an env value can never add YAML structure (T-01-17).
 * `failed` collects the JSON pointers of values whose placeholder failed; they get no second issue.
 */
function interpolate(
	node: unknown,
	at: string,
	env: NodeJS.ProcessEnv,
	failed: Set<string>,
	found: Collector,
): unknown {
	if (typeof node === "string") {
		if (!node.includes("${")) return node;
		const resolved = interpolateString(node, at, env, found);
		if (resolved === undefined) {
			failed.add(at);
			return "";
		}
		return resolved;
	}
	if (Array.isArray(node)) {
		return node.map((item, index) =>
			interpolate(item, at + pointer(index), env, failed, found),
		);
	}
	if (isRecord(node)) {
		return Object.fromEntries(
			Object.entries(node).map(([key, value]) => [
				key,
				interpolate(value, at + pointer(key), env, failed, found),
			]),
		);
	}
	return node;
}

// --- stage 4: PORT and LOG_LEVEL ---------------------------------------------

function applyEnvOverrides(
	document: unknown,
	env: NodeJS.ProcessEnv,
	found: Collector,
): unknown {
	if (!isRecord(document)) return document;
	if (document.server !== undefined && !isRecord(document.server)) {
		return document;
	}
	const server: Record<string, unknown> = { ...(document.server as object) };

	const port = env.PORT;
	if (port !== undefined) {
		if (/^\d+$/.test(port) && Number(port) <= 65535) {
			server.port = Number(port);
		} else {
			found.add({ code: "env.INVALID_PORT", at: "PORT" });
		}
	}
	const level = env.LOG_LEVEL;
	if (level !== undefined) {
		if ((LOG_LEVELS as readonly string[]).includes(level)) {
			server.logLevel = level;
		} else {
			found.add({ code: "env.INVALID_LOG_LEVEL", at: "LOG_LEVEL" });
		}
	}
	return Object.keys(server).length > 0 ? { ...document, server } : document;
}

// --- stages 5 and 6: schema and semantic -------------------------------------

function schemaIssues(document: unknown, failed: Set<string>): ConfigIssue[] {
	if (validate(document)) return [];
	const found = collector();
	for (const error of validate.errors ?? []) {
		if (failed.has(error.instancePath)) continue;
		const params = error.params as {
			additionalProperty?: string;
			missingProperty?: string;
		};
		const named = params.additionalProperty ?? params.missingProperty;
		found.add({
			code: `schema.${error.keyword}`,
			at: error.instancePath + (named === undefined ? "" : pointer(named)),
		});
	}
	return found.issues;
}

function webdavUrlIssue(
	document: unknown,
	failed: Set<string>,
): ConfigIssue | undefined {
	const at = "/storage/webdav/url";
	if (failed.has(at)) return undefined;
	if (!isRecord(document) || !isRecord(document.storage)) return undefined;
	const webdav = document.storage.webdav;
	if (!isRecord(webdav) || typeof webdav.url !== "string") return undefined;
	let url: URL;
	try {
		url = new URL(webdav.url);
	} catch {
		return { code: "storage.INVALID_URL", at };
	}
	if (url.protocol === "https:") return undefined;
	if (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)) {
		return undefined;
	}
	return { code: "storage.INSECURE_URL", at };
}

/** An IP, or `<ip>/<prefix>` with prefix 0..32 (IPv4) or 0..128 (IPv6). Zones and bare booleans are not accepted. */
function isTrustProxyEntry(entry: string): boolean {
	const slash = entry.indexOf("/");
	const address = slash === -1 ? entry : entry.slice(0, slash);
	const family = isIP(address);
	if (family === 0 || address.includes("%")) return false;
	if (slash === -1) return true;
	const prefix = entry.slice(slash + 1);
	return (
		/^(0|[1-9]\d{0,2})$/.test(prefix) &&
		Number(prefix) <= (family === 4 ? 32 : 128)
	);
}

/** The issue names the index only, never the entry (D-10). */
function trustProxyIssues(document: unknown): ConfigIssue[] {
	if (!isRecord(document) || !isRecord(document.server)) return [];
	const { trustProxy } = document.server;
	if (!Array.isArray(trustProxy)) return [];
	const issues: ConfigIssue[] = [];
	trustProxy.forEach((entry, index) => {
		if (typeof entry === "string" && !isTrustProxyEntry(entry)) {
			issues.push({
				code: "server.INVALID_TRUST_PROXY",
				at: `/server/trustProxy/${index}`,
			});
		}
	});
	return issues;
}

function mountIssues(document: unknown, failed: Set<string>): ConfigIssue[] {
	if (!isRecord(document) || !isRecord(document.mounts)) return [];
	const defs: Record<string, MountDef> = {};
	for (const [name, entry] of Object.entries(document.mounts)) {
		if (!MOUNT_NAME.test(name) || !isRecord(entry)) continue;
		const { path, mode } = entry;
		if (typeof path !== "string" || failed.has(`/mounts/${name}/path`)) {
			continue;
		}
		if (mode !== "read" && mode !== "read-write") continue;
		defs[name] = { path, mode: mode as MountMode };
	}
	const built = buildMounts(defs);
	return built.ok ? [] : built.issues;
}

/** Document position of an issue: its node, else the end of the nearest parent (a missing key). */
function offsetOf(doc: Document.Parsed, at: string | undefined): number {
	const segments =
		(at ?? "")
			.split(" ")[0]
			?.split("/")
			.slice(1)
			.map((s) => s.replaceAll("~1", "/").replaceAll("~0", "~")) ?? [];
	for (let length = segments.length; length >= 0; length--) {
		const node = doc.getIn(segments.slice(0, length), true);
		if (isNode(node) && node.range) {
			return length === segments.length ? node.range[0] : node.range[1];
		}
	}
	return Number.POSITIVE_INFINITY;
}

function inDocumentOrder(
	doc: Document.Parsed,
	issues: ConfigIssue[],
): ConfigIssue[] {
	return issues
		.map((issue) => ({ issue, offset: offsetOf(doc, issue.at) }))
		.sort((a, b) => a.offset - b.offset)
		.map(({ issue }) => issue);
}

// --- result ------------------------------------------------------------------

const DEFAULT_RATE_LIMIT = { max: 10, windowSeconds: 60 };

function withCollectionDefaults(collections: unknown): Config["collections"] {
	return Object.fromEntries(
		Object.entries(
			(collections ?? {}) as Record<string, Record<string, unknown>>,
		).map(([name, entry]) => [
			name,
			{
				...entry,
				bodyLimit:
					(entry.bodyLimit as number | undefined) ?? DEFAULT_BODY_LIMIT,
				rateLimit: {
					...DEFAULT_RATE_LIMIT,
					...(entry.rateLimit as object | undefined),
				},
			},
		]),
	) as Config["collections"];
}

function withDefaults(document: Record<string, unknown>): Config {
	const server = (document.server ?? {}) as Partial<Config["server"]>;
	const webdav = (document.storage as { webdav: Record<string, unknown> })
		.webdav;
	return {
		server: {
			port: server.port ?? 3000,
			logLevel: server.logLevel ?? "info",
			trustProxy: server.trustProxy ?? [],
		},
		mongo: document.mongo as Config["mongo"],
		storage: {
			webdav: {
				...(webdav as Omit<Config["storage"]["webdav"], "concurrency">),
				concurrency: (webdav.concurrency as number | undefined) ?? 2,
			},
		},
		mounts: document.mounts as Config["mounts"],
		collections: withCollectionDefaults(document.collections),
		apiKeys: (document.apiKeys ?? []) as Config["apiKeys"],
	};
}

function deepFreeze<T>(value: T): T {
	if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const child of Object.values(value)) deepFreeze(child);
	}
	return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const path = env.CONFIG_FILE ?? DEFAULT_CONFIG_FILE;

	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		throw new ConfigError([{ code: "file.UNREADABLE", at: path }]);
	}

	const doc = parseDocument(text);
	if (doc.errors.length > 0) throw new ConfigError(yamlIssues(doc));

	const envIssues = collector();
	const failed = new Set<string>();
	const resolved = interpolate(doc.toJS() ?? {}, "", env, failed, envIssues);
	const overridden = applyEnvOverrides(resolved, env, envIssues);

	// Sibling-file schemas are read before the schema stage; ones that fail are not checked twice.
	const refs = resolveSchemaRefs(overridden, dirname(resolve(path)));
	const document = refs.document;
	for (const at of refs.failed) failed.add(at);

	const semantic: ConfigIssue[] = [...refs.issues];
	const urlIssue = webdavUrlIssue(document, failed);
	if (urlIssue !== undefined) semantic.push(urlIssue);
	semantic.push(...trustProxyIssues(document));
	semantic.push(...mountIssues(document, failed));
	semantic.push(...collectionIssues(document, failed));
	semantic.push(...apiKeyIssues(document, failed));

	const issues = [
		...envIssues.issues,
		...inDocumentOrder(doc, schemaIssues(document, failed)),
		...inDocumentOrder(doc, semantic),
	];
	if (issues.length > 0) throw new ConfigError(issues);
	return deepFreeze(withDefaults(document as Record<string, unknown>));
}
