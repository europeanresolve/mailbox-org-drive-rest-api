import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseDocument } from "yaml";
import {
	buildMounts,
	type MountDef,
	type MountMode,
} from "../storage/mounts.ts";
import { type Config, ConfigSchema, MOUNT_NAME_PATTERN } from "./schema.ts";

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
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
	ConfigSchema,
);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pointer(segment: string): string {
	return `/${segment.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function schemaIssues(document: unknown): ConfigIssue[] {
	if (validate(document)) return [];
	return (validate.errors ?? []).map((error) => {
		const params = error.params as {
			additionalProperty?: string;
			missingProperty?: string;
		};
		const named = params.additionalProperty ?? params.missingProperty;
		return {
			code: `schema.${error.keyword}`,
			at: error.instancePath + (named === undefined ? "" : pointer(named)),
		};
	});
}

function webdavUrlIssue(document: unknown): ConfigIssue | undefined {
	if (!isRecord(document) || !isRecord(document.storage)) return undefined;
	const webdav = document.storage.webdav;
	if (!isRecord(webdav) || typeof webdav.url !== "string") return undefined;
	const at = "/storage/webdav/url";
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

function mountIssues(document: unknown): ConfigIssue[] {
	if (!isRecord(document) || !isRecord(document.mounts)) return [];
	const defs: Record<string, MountDef> = {};
	for (const [name, entry] of Object.entries(document.mounts)) {
		if (!MOUNT_NAME.test(name) || !isRecord(entry)) continue;
		const { path, mode } = entry;
		if (typeof path !== "string") continue;
		if (mode !== "read" && mode !== "read-write") continue;
		defs[name] = { path, mode: mode as MountMode };
	}
	const built = buildMounts(defs);
	return built.ok ? [] : built.issues;
}

function withDefaults(document: Record<string, unknown>): Config {
	const server = (document.server ?? {}) as Partial<Config["server"]>;
	const webdav = (document.storage as { webdav: Record<string, unknown> })
		.webdav;
	return {
		server: { port: server.port ?? 3000, logLevel: server.logLevel ?? "info" },
		mongo: document.mongo as Config["mongo"],
		storage: {
			webdav: {
				...(webdav as Omit<Config["storage"]["webdav"], "concurrency">),
				concurrency: (webdav.concurrency as number | undefined) ?? 2,
			},
		},
		mounts: document.mounts as Config["mounts"],
	};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const path = env.CONFIG_FILE ?? DEFAULT_CONFIG_FILE;
	const document: unknown =
		parseDocument(readFileSync(path, "utf8")).toJS() ?? {};

	const issues: ConfigIssue[] = [...schemaIssues(document)];
	const urlIssue = webdavUrlIssue(document);
	if (urlIssue !== undefined) issues.push(urlIssue);
	issues.push(...mountIssues(document));

	if (issues.length > 0) throw new ConfigError(issues);
	return withDefaults(document as Record<string, unknown>);
}
