import http from "node:http";
import net from "node:net";
import * as undici from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureHttpDispatcher } from "../src/core/http-dispatcher.ts";

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy"] as const;

describe("fix-core #8134 proxied plain-HTTP requests", () => {
	const originalDispatcher = undici.getGlobalDispatcher();
	const originalFetch = globalThis.fetch;
	let savedEnv: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>> = {};

	beforeEach(() => {
		savedEnv = {};
		for (const key of PROXY_ENV_KEYS) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(async () => {
		const dispatcher = undici.getGlobalDispatcher();
		if (dispatcher !== originalDispatcher) {
			await dispatcher.close();
			undici.setGlobalDispatcher(originalDispatcher);
		}
		for (const key of PROXY_ENV_KEYS) {
			const value = savedEnv[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		globalThis.fetch = originalFetch;
	});

	it("tunnels HTTP origins through CONNECT", async () => {
		const origin = http.createServer((_request, response) => {
			response.end("origin");
		});
		await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
		const originAddress = origin.address();
		if (!originAddress || typeof originAddress === "string") throw new Error("Origin did not bind to a TCP port");

		const proxyRequestLines: string[] = [];
		const proxy = net.createServer((client) => {
			client.once("data", (data) => {
				const [requestLine = ""] = data.toString().split("\r\n");
				proxyRequestLines.push(requestLine);
				if (!requestLine.startsWith("CONNECT ")) {
					client.end("HTTP/1.1 501 Not Implemented\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
					return;
				}
				const upstream = net.connect(originAddress.port, "127.0.0.1", () => {
					client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
					client.pipe(upstream).pipe(client);
				});
				upstream.on("error", () => client.destroy());
				client.on("error", () => upstream.destroy());
			});
		});
		await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
		const proxyAddress = proxy.address();
		if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Proxy did not bind to a TCP port");

		process.env.HTTP_PROXY = `http://127.0.0.1:${proxyAddress.port}`;
		configureHttpDispatcher();
		try {
			const originUrl = `http://127.0.0.1:${originAddress.port}/v1/chat/completions`;
			await expect(undici.fetch(originUrl).then((response) => response.text())).resolves.toBe("origin");
			expect(proxyRequestLines).toEqual(
				expect.arrayContaining([
					expect.stringMatching(`^CONNECT 127\\.0\\.0\\.1:${originAddress.port} HTTP/1\\.1$`),
				]),
			);
		} finally {
			await undici.getGlobalDispatcher().close();
			undici.setGlobalDispatcher(originalDispatcher);
			await Promise.all([
				new Promise<void>((resolve) => proxy.close(() => resolve())),
				new Promise<void>((resolve) => origin.close(() => resolve())),
			]);
		}
	});
});
