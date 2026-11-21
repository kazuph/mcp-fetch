import { afterEach, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
vi.mock("node:dns", () => ({ default: { promises: { lookup } } }));

process.env.MCP_FETCH_DISABLE_SERVER = "1";
process.env.MCP_FETCH_DISABLE_SSRF_GUARD = "0";

// @ts-expect-error importing compiled file without types
const { safeFollowFetch } = await import("../dist/index.js");

afterEach(() => {
  lookup.mockReset();
  vi.unstubAllGlobals();
});

it.each([
  ["IPv6 loopback", "[::1]"],
  ["IPv4-mapped IPv6", "[::ffff:c000:201]"],
  ["IPv6 link-local", "[fe90::1]"],
  ["IPv6 unique-local", "[fd00::1]"],
  ["IPv4 loopback", "127.0.0.1"],
])("blocks %s without DNS or fetch", async (_kind, host) => {
  const request = vi.fn();
  vi.stubGlobal("fetch", request);

  await expect(safeFollowFetch(`https://${host}/`)).rejects.toThrow(
    /blocked url/i
  );
  expect(lookup).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});

it("allows a public IPv6 literal without DNS", async () => {
  const request = vi.fn().mockResolvedValue(new Response("ok"));
  vi.stubGlobal("fetch", request);

  await expect(
    safeFollowFetch("https://[2606:4700:4700::1111]/")
  ).resolves.toMatchObject({ response: { status: 200 } });
  expect(lookup).not.toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});

it("blocks a redirect to a non-public address before requesting it", async () => {
  lookup.mockResolvedValue([{ address: "8.8.8.8" }]);
  const request = vi.fn().mockResolvedValue(
    new Response(null, {
      status: 302,
      headers: { location: "http://127.0.0.1/" },
    })
  );
  vi.stubGlobal("fetch", request);

  await expect(safeFollowFetch("https://public.example/")).rejects.toThrow(
    /blocked url/i
  );
  expect(request).toHaveBeenCalledTimes(1);
  expect(request).toHaveBeenCalledWith(
    "https://public.example/",
    expect.objectContaining({ redirect: "manual" })
  );
});

it("rejects a hostname when any resolved address is non-public", async () => {
  lookup.mockResolvedValue([{ address: "8.8.8.8" }, { address: "fd00::1" }]);
  const request = vi.fn();
  vi.stubGlobal("fetch", request);

  await expect(safeFollowFetch("https://mixed.example/")).rejects.toThrow(
    /blocked url/i
  );
  expect(request).not.toHaveBeenCalled();
});

it("does not fetch if DNS failed", async () => {
  lookup.mockRejectedValue(new Error("DNS failure"));
  const request = vi.fn();
  vi.stubGlobal("fetch", request);

  await expect(safeFollowFetch("https://unresolved.example/")).rejects.toThrow(
    /no verified address/i
  );
  expect(request).not.toHaveBeenCalled();
});
