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
	},
	{ additionalProperties: false },
);

/** The resolved config: defaults filled in, deeply readonly. */
export type Config = {
	readonly server: {
		readonly port: number;
		readonly logLevel: LogLevel;
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
};
