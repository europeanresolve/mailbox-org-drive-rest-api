import Type from "typebox";

export const LOG_LEVELS = [
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace",
	"silent",
] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const MOUNT_NAME_PATTERN = "^[a-z][a-z0-9-]{0,31}$";

export const COLLECTION_OPERATIONS = [
	"create",
	"get",
	"list",
	"replace",
	"patch",
	"delete",
] as const;
export type CollectionOperation = (typeof COLLECTION_OPERATIONS)[number];

export const COLLECTION_POLICIES = ["anonymous", "apiKey"] as const;
export type CollectionPolicy = (typeof COLLECTION_POLICIES)[number];

const operationsSchema = Type.Object(
	Object.fromEntries(
		COLLECTION_OPERATIONS.map((op) => [
			op,
			Type.Optional(Type.Enum([...COLLECTION_POLICIES])),
		]),
	),
	{ additionalProperties: false },
);

// additionalProperties false at every level: an unknown key is a typo, not an extension.
// Type.Enum (not a Union of Literals) keeps one bad value to one issue.
export const ConfigSchema = Type.Object(
	{
		server: Type.Optional(
			Type.Object(
				{
					// 0 = ephemeral port, used by tests.
					port: Type.Optional(Type.Integer({ minimum: 0, maximum: 65535 })),
					logLevel: Type.Optional(Type.Enum([...LOG_LEVELS])),
					trustProxy: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
				},
				{ additionalProperties: false },
			),
		),
		mongo: Type.Object(
			{ uri: Type.String({ minLength: 1 }) },
			{ additionalProperties: false },
		),
		storage: Type.Object(
			{
				webdav: Type.Object(
					{
						url: Type.String({ minLength: 1 }),
						username: Type.String({ minLength: 1 }),
						password: Type.String({ minLength: 1 }),
						concurrency: Type.Optional(
							Type.Integer({ minimum: 1, maximum: 4 }),
						),
					},
					{ additionalProperties: false },
				),
			},
			{ additionalProperties: false },
		),
		// Options on the Record are what reject a bad name: without them the key
		// pattern becomes patternProperties and Bad_Name is silently accepted.
		mounts: Type.Record(
			Type.String({ pattern: MOUNT_NAME_PATTERN }),
			Type.Object(
				{
					path: Type.String({ minLength: 1 }),
					mode: Type.Enum(["read", "read-write"]),
				},
				{ additionalProperties: false },
			),
			{ additionalProperties: false, minProperties: 1 },
		),
		// The schema is the deployer's JSON Schema; strict Ajv checks it in the semantic stage.
		collections: Type.Optional(
			Type.Record(
				Type.String({ pattern: MOUNT_NAME_PATTERN }),
				Type.Object(
					{
						schema: Type.Record(Type.String(), Type.Unknown()),
						operations: operationsSchema,
						indexes: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
						rateLimit: Type.Optional(
							Type.Object(
								{
									max: Type.Optional(Type.Integer({ minimum: 1 })),
									windowSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
								},
								{ additionalProperties: false },
							),
						),
						cors: Type.Optional(
							Type.Object(
								{ origins: Type.Array(Type.String({ minLength: 1 })) },
								{ additionalProperties: false },
							),
						),
					},
					{ additionalProperties: false },
				),
				{ additionalProperties: false },
			),
		),
		apiKeys: Type.Optional(
			Type.Array(
				Type.Object(
					{
						name: Type.String({ pattern: MOUNT_NAME_PATTERN }),
						hash: Type.String({ pattern: "^[0-9a-f]{64}$" }),
						grants: Type.Array(Type.String({ minLength: 1 })),
					},
					{ additionalProperties: false },
				),
			),
		),
	},
	{ additionalProperties: false },
);

/** The resolved config: defaults filled in, deeply readonly. */
export type Config = {
	readonly server: {
		readonly port: number;
		readonly logLevel: LogLevel;
		/** Proxy IPs or CIDRs whose X-Forwarded-For is believed; empty means none. */
		readonly trustProxy: readonly string[];
	};
	readonly mongo: { readonly uri: string };
	readonly storage: {
		readonly webdav: {
			readonly url: string;
			readonly username: string;
			readonly password: string;
			readonly concurrency: number;
		};
	};
	readonly mounts: {
		readonly [name: string]: {
			readonly path: string;
			readonly mode: "read" | "read-write";
		};
	};
	readonly collections: {
		readonly [name: string]: {
			readonly schema: { readonly [keyword: string]: unknown };
			readonly operations: {
				readonly [op in CollectionOperation]?: CollectionPolicy;
			};
			/** Dotted paths into the schema that may be filtered and sorted on. */
			readonly indexes?: readonly string[];
			/** Browser origins allowed to call the collection; none when absent. */
			readonly cors?: { readonly origins: readonly string[] };
			/** In-app limit per client IP on the collection's anonymous operations. */
			readonly rateLimit: {
				readonly max: number;
				readonly windowSeconds: number;
			};
		};
	};
	readonly apiKeys: readonly {
		readonly name: string;
		readonly hash: string;
		readonly grants: readonly string[];
	}[];
};
