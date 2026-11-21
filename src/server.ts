import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.ts";

export async function start(
	options: { port?: number; host?: string } = {},
): Promise<FastifyInstance> {
	const app = buildApp();
	const host = options.host ?? "0.0.0.0";
	const port = options.port ?? Number(process.env.PORT ?? 3000);

	const shutdown = (): void => {
		app.close().then(
			() => process.exit(0),
			() => process.exit(1),
		);
	};
	process.once("SIGTERM", shutdown);
	process.once("SIGINT", shutdown);

	await app.listen({ host, port });
	return app;
}

if (import.meta.main) {
	await start();
}
