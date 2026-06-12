import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Small HTML byte cap so the incremental size guard is easy to trip, and
// SSRF guard disabled so we can talk to local 127.0.0.1 test servers.
// These env vars are read at module load, so set them BEFORE importing.
process.env.MCP_FETCH_DISABLE_SERVER = "1";
process.env.MCP_FETCH_DISABLE_SSRF_GUARD = "1";
process.env.MCP_FETCH_MAX_HTML_BYTES = "200";

// @ts-expect-error importing compiled file without types
const { fetchUrl } = await import("../dist/index.js");

function startServer(handler: http.RequestListener): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

function portOf(srv: http.Server): number {
  const addr = srv.address();
  if (addr && typeof addr === "object") return addr.port;
  throw new Error("no port");
}

describe("native fetch network behavior (node-fetch replacement)", () => {
  let srv: http.Server;
  let port: number;

  beforeAll(async () => {
    srv = await startServer((req, res) => {
      if (req.url === "/redir") {
        res.writeHead(302, { Location: `http://127.0.0.1:${port}/dest` });
        res.end();
        return;
      }
      if (req.url === "/dest") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          "<!doctype html><html><body><article><h1>Dest</h1><p>arrived after redirect</p></article></body></html>"
        );
        return;
      }
      if (req.url === "/big") {
        // No Content-Length (chunked) so the cap must be enforced mid-stream,
        // not via the early content-length short-circuit.
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        for (let i = 0; i < 50; i++) {
          res.write("<p>0123456789012345678901234567890123456789</p>");
        }
        res.end();
        return;
      }
      res.writeHead(404).end();
    });
    port = portOf(srv);
  });

  afterAll(async () => {
    await new Promise((r) => srv.close(() => r(null)));
  });

  it("follows 302 redirects and returns the destination content", async () => {
    const result = await fetchUrl(
      `http://127.0.0.1:${port}/redir`,
      "test",
      true
    );
    expect(result.content).toContain("arrived after redirect");
  });

  it("enforces the byte cap incrementally on a chunked response", async () => {
    await expect(
      fetchUrl(`http://127.0.0.1:${port}/big`, "test", true)
    ).rejects.toThrow(/exceeded limit/i);
  });
});
