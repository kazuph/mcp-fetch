import { promises as fs } from "node:fs";
import http from "node:http";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Disable server startup and SSRF guard for local test servers
process.env.MCP_FETCH_DISABLE_SERVER = "1";
process.env.MCP_FETCH_DISABLE_SSRF_GUARD = "1";
// Import after setting env so guards read the right values
// @ts-expect-error importing compiled file without types
const { fetchUrl } = await import("../dist/index.js");

function startServer(
  port: number,
  handler: http.RequestListener
): Promise<http.Server> {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(port, "127.0.0.1", () => resolve(srv));
  });
}

let IMG_BUF: Buffer;

describe("imageFetch pipeline", () => {
  const PORT_PAGE = 19081;
  const PORT_IMG = 19082;
  let pageSrv: http.Server;
  let imgSrv: http.Server;

  beforeAll(async () => {
    IMG_BUF = await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 3,
        background: { r: 255, g: 0, b: 0 },
      },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    imgSrv = await startServer(PORT_IMG, (req, res) => {
      if (req.url === "/img.jpg") {
        res.writeHead(200, {
          "Content-Type": "image/jpeg",
          "Content-Length": IMG_BUF.length,
        });
        res.end(IMG_BUF);
      } else {
        res.writeHead(404).end();
      }
    });

    pageSrv = await startServer(PORT_PAGE, (_req, res) => {
      const html = `<!doctype html><html><head><title>T</title></head><body>
        <article><h1>Title</h1><p>Hello</p>
          <img src="http://127.0.0.1:${PORT_IMG}/img.jpg" alt="r">
        </article>
      </body></html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });
  });

  afterAll(async () => {
    await new Promise((r) => pageSrv.close(() => r(null)));
    await new Promise((r) => imgSrv.close(() => r(null)));
  });

  it("returns base64 image and saves file by default (cross-origin allowed)", async () => {
    const result = await fetchUrl(
      `http://127.0.0.1:${PORT_PAGE}/`,
      "test-agent",
      false,
      {
        enableFetchImages: true,
        imageMaxCount: 1,
        startIndex: 0,
        maxLength: 1000,
        imageStartIndex: 0,
        imageMaxHeight: 4000,
        imageMaxWidth: 1000,
        imageQuality: 80,
        returnBase64: true,
        saveImages: true,
        allowCrossOriginImages: true, // default true but be explicit
      }
    );

    expect(result.images.length).toBe(1);
    expect(result.images[0].mimeType).toBe("image/jpeg");
    expect(result.images[0].data.length).toBeGreaterThan(10);
    expect(result.images[0].filePath).toBeTruthy();
    const pth = result.images[0].filePath || "";
    const stat = await fs.stat(pth);
    expect(stat.isFile()).toBe(true);
  });

  it("blocks cross-origin when explicitly disabled", async () => {
    const result = await fetchUrl(
      `http://127.0.0.1:${PORT_PAGE}/`,
      "test-agent",
      false,
      {
        enableFetchImages: true,
        imageMaxCount: 1,
        startIndex: 0,
        maxLength: 1000,
        imageStartIndex: 0,
        imageMaxHeight: 4000,
        imageMaxWidth: 1000,
        imageQuality: 80,
        returnBase64: true,
        saveImages: false,
        allowCrossOriginImages: false,
      }
    );
    expect(result.images.length).toBe(0);
  });
});
