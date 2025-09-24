#!/usr/bin/env node

import dns from "node:dns";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import type { Readable } from "node:stream";
import { URL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { RequestInit } from "node-fetch";
import fetch, { type Response as FetchResponse } from "node-fetch";
import robotsParser from "robots-parser";
import sharp from "sharp";
import TurndownService from "turndown";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

interface Image {
  src: string;
  alt: string;
  data?: Buffer;
  filename?: string;
}

interface ExtractedContent {
  markdown: string;
  images: Image[];
  title?: string;
}

interface ImageResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  filePath: string;
}

// Global resource registry for images
const imageResources = new Map<string, ImageResource>();

// Server instance to send notifications
let serverInstance: Server;

// --------------------
// Security hardening
// --------------------
// Defaults (can be overridden by env vars)
const FETCH_TIMEOUT_MS = Number(process.env.MCP_FETCH_TIMEOUT_MS || 12000);
const MAX_REDIRECTS = Number(process.env.MCP_FETCH_MAX_REDIRECTS || 3);
const MAX_HTML_BYTES = Number(
  process.env.MCP_FETCH_MAX_HTML_BYTES || 2_000_000
); // 2MB
const MAX_IMAGE_BYTES = Number(
  process.env.MCP_FETCH_MAX_IMAGE_BYTES || 10_000_000
); // 10MB
const DISABLE_SSRF_GUARD = process.env.MCP_FETCH_DISABLE_SSRF_GUARD === "1";

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((v) => Number(v));
  if (
    parts.length !== 4 ||
    parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)
  )
    return false;
  const [a, b] = parts;
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // non-routable
  if (a >= 224 && a <= 239) return true; // multicast
  if (a >= 240) return true; // reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fe80:") || // link-local
    lower.startsWith("fc") || // fc00::/7 (fc/fd)
    lower.startsWith("fd") ||
    lower.startsWith("ff") // multicast
  );
}

async function resolveAllIps(hostname: string): Promise<string[]> {
  try {
    const records = await dns.promises.lookup(hostname, {
      all: true,
      verbatim: true,
    });
    return records.map((r) => r.address);
  } catch {
    return [];
  }
}

async function isSafeUrl(
  input: string
): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (!(u.protocol === "http:" || u.protocol === "https:")) {
    return { ok: false, reason: "Only http/https schemes are allowed" };
  }
  if (DISABLE_SSRF_GUARD) {
    return { ok: true, url: u };
  }
  const hostname = u.hostname;
  if (!hostname) return { ok: false, reason: "Missing hostname" };
  const isIp = net.isIP(hostname) !== 0;
  if (isIp) {
    if (net.isIP(hostname) === 4 && isPrivateIPv4(hostname)) {
      return { ok: false, reason: "IPv4 address is private/reserved" };
    }
    if (net.isIP(hostname) === 6 && isPrivateIPv6(hostname)) {
      return { ok: false, reason: "IPv6 address is private/reserved" };
    }
  } else {
    const lower = hostname.toLowerCase();
    if (
      lower === "localhost" ||
      lower.endsWith(".localhost") ||
      lower.endsWith(".local")
    ) {
      return { ok: false, reason: "Local hostnames are not allowed" };
    }
    const ips = await resolveAllIps(hostname);
    for (const ip of ips) {
      if (
        (net.isIP(ip) === 4 && isPrivateIPv4(ip)) ||
        (net.isIP(ip) === 6 && isPrivateIPv6(ip))
      ) {
        return {
          ok: false,
          reason: "Hostname resolves to private/reserved address",
        };
      }
    }
  }
  return { ok: true, url: u };
}

function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label = "request"
): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function safeFollowFetch(
  inputUrl: string,
  init: RequestInit = {},
  opts: { maxRedirects?: number; timeoutMs?: number } = {}
): Promise<{ response: FetchResponse; finalUrl: string }> {
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  let current = inputUrl;
  for (let i = 0; i <= maxRedirects; i++) {
    const safe = await isSafeUrl(current);
    if (!safe.ok) throw new Error(`Blocked URL: ${safe.reason}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const reqInit: RequestInit = {
        ...(init || {}),
        redirect: "manual",
        signal: controller.signal,
      };
      const resp: FetchResponse = await fetch(current, reqInit);
      clearTimeout(timer);
      if ([301, 302, 303, 307, 308].includes(resp.status)) {
        const loc = resp.headers.get("location");
        if (!loc)
          throw new Error(
            `Redirect status ${resp.status} without Location header`
          );
        const next = new URL(loc, current).toString();
        current = next;
        continue;
      }
      return { response: resp, finalUrl: current };
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  }
  throw new Error("Too many redirects");
}

async function readTextLimited(
  resp: FetchResponse,
  maxBytes: number
): Promise<{ text: string; contentType: string }> {
  const ct = resp.headers.get("content-type") || "";
  const cl = resp.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) {
    throw new Error(`Response too large (${cl} bytes > ${maxBytes})`);
  }
  const body = resp.body as Readable | null;
  if (!body || typeof body.on !== "function") {
    const text = await withTimeout(resp.text(), FETCH_TIMEOUT_MS, "read text");
    return { text, contentType: ct };
  }
  let size = 0;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    body.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        body.destroy();
        reject(new Error(`Response exceeded limit (${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    body.on("end", () => resolve());
    body.on("error", (err: Error) => reject(err));
  });
  return { text: Buffer.concat(chunks).toString("utf8"), contentType: ct };
}

async function readBufferLimited(
  resp: FetchResponse,
  maxBytes: number
): Promise<Buffer> {
  const cl = resp.headers.get("content-length");
  if (cl && Number(cl) > maxBytes) {
    throw new Error(`Response too large (${cl} bytes > ${maxBytes})`);
  }
  const body = resp.body as Readable | null;
  if (!body || typeof body.on !== "function") {
    const ab = await withTimeout(
      resp.arrayBuffer(),
      FETCH_TIMEOUT_MS,
      "read buffer"
    );
    const buf = Buffer.from(ab);
    if (buf.length > maxBytes)
      throw new Error(`Response exceeded limit (${maxBytes} bytes)`);
    return buf;
  }
  let size = 0;
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    body.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        body.destroy();
        reject(new Error(`Response exceeded limit (${maxBytes} bytes)`));
        return;
      }
      chunks.push(chunk);
    });
    body.on("end", () => resolve());
    body.on("error", (err: Error) => reject(err));
  });
  return Buffer.concat(chunks);
}

/**
 * リソースリストが変更されたことをクライアントに通知
 */
async function notifyResourcesChanged(): Promise<void> {
  if (serverInstance) {
    try {
      await serverInstance.sendResourceListChanged();
    } catch (error) {
      console.warn("Failed to notify resource list changed:", error);
    }
  }
}

/**
 * 既存のダウンロードファイルをスキャンしてリソースとして登録
 */
async function scanAndRegisterExistingFiles(): Promise<void> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const baseDir = path.join(homeDir, "Downloads", "mcp-fetch");

  try {
    // 日付ディレクトリをスキャン
    const dateDirs = await fs.readdir(baseDir);

    for (const dateDir of dateDirs) {
      if (dateDir.startsWith(".")) continue; // .DS_Store などをスキップ

      const datePath = path.join(baseDir, dateDir);
      const stats = await fs.stat(datePath);

      if (!stats.isDirectory()) continue;

      try {
        // 日付ディレクトリ直下のファイルをチェック
        const files = await fs.readdir(datePath);

        for (const file of files) {
          if (!file.toLowerCase().endsWith(".jpg")) continue;

          const filePath = path.join(datePath, file);
          const fileStats = await fs.stat(filePath);

          if (!fileStats.isFile()) continue;

          // リソースURIを生成 (file:// scheme)
          const resourceUri = `file://${filePath}`;

          // ファイル名から情報を抽出
          const baseName = path.basename(file, ".jpg");
          const isIndividual = file.includes("individual");

          const resourceName = `${dateDir}/${baseName}`;
          const description = `${isIndividual ? "Individual" : "Merged"} image from ${dateDir}`;

          const resource: ImageResource = {
            uri: resourceUri,
            name: resourceName,
            description,
            mimeType: "image/jpeg",
            filePath,
          };

          imageResources.set(resourceUri, resource);
        }

        // サブディレクトリもチェック (individual/merged が存在する場合)
        const subDirs = ["individual", "merged"];

        for (const subDir of subDirs) {
          const subDirPath = path.join(datePath, subDir);

          try {
            const subFiles = await fs.readdir(subDirPath);

            for (const file of subFiles) {
              if (!file.toLowerCase().endsWith(".jpg")) continue;

              const filePath = path.join(subDirPath, file);
              const fileStats = await fs.stat(filePath);

              if (!fileStats.isFile()) continue;

              // リソースURIを生成 (file:// scheme)
              const resourceUri = `file://${filePath}`;

              // ファイル名から情報を抽出
              const baseName = path.basename(file, ".jpg");
              const resourceName = `${dateDir}/${subDir}/${baseName}`;
              const description = `${subDir === "individual" ? "Individual" : "Merged"} image from ${dateDir}`;

              const resource: ImageResource = {
                uri: resourceUri,
                name: resourceName,
                description,
                mimeType: "image/jpeg",
                filePath,
              };

              imageResources.set(resourceUri, resource);
            }
          } catch (_error) {
            // サブディレクトリが存在しない場合はスキップ
          }
        }
      } catch (error) {
        console.warn(`Failed to scan directory ${datePath}:`, error);
      }
    }

    console.error(`Registered ${imageResources.size} existing image resources`);
  } catch (error) {
    console.warn("Failed to scan existing downloads:", error);
  }
}

const DEFAULT_USER_AGENT_AUTONOMOUS =
  "ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)";
// const DEFAULT_USER_AGENT_MANUAL =
//   "ModelContextProtocol/1.0 (User-Specified; +https://github.com/modelcontextprotocol/servers)";

/**
 * URLから元のファイル名を抽出
 */
function extractFilenameFromUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = path.basename(pathname);

    // ファイル名が空の場合や拡張子がない場合のデフォルト処理
    if (!filename || !filename.includes(".")) {
      return "image.jpg";
    }

    return filename;
  } catch {
    return "image.jpg";
  }
}

const FetchArgsSchema = z.object({
  url: z
    .string()
    .url()
    .refine(
      (val) => {
        try {
          const u = new URL(val);
          return u.protocol === "http:" || u.protocol === "https:";
        } catch {
          return false;
        }
      },
      { message: "Only http/https URLs are allowed" }
    ),
  maxLength: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .pipe(z.number().positive().max(1000000))
    .default(20000),
  startIndex: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .pipe(z.number().min(0))
    .default(0),
  imageStartIndex: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .pipe(z.number().min(0))
    .default(0),
  raw: z
    .union([z.boolean(), z.string()])
    .transform((val) =>
      typeof val === "string" ? val.toLowerCase() === "true" : val
    )
    .default(false),
  imageMaxCount: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .pipe(z.number().min(0).max(10))
    .default(3),
  imageMaxHeight: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .pipe(z.number().min(100).max(10000))
    .default(4000),
  imageMaxWidth: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .pipe(z.number().min(100).max(10000))
    .default(1000),
  imageQuality: z
    .union([z.number(), z.string()])
    .transform((val) => Number(val))
    .pipe(z.number().min(1).max(100))
    .default(80),
  enableFetchImages: z
    .union([z.boolean(), z.string()])
    .transform((val) =>
      typeof val === "string" ? val.toLowerCase() === "true" : val
    )
    .default(false),
  allowCrossOriginImages: z
    .union([z.boolean(), z.string()])
    .transform((val) =>
      typeof val === "string" ? val.toLowerCase() === "true" : val
    )
    .default(true),
  ignoreRobotsTxt: z
    .union([z.boolean(), z.string()])
    .transform((val) =>
      typeof val === "string" ? val.toLowerCase() === "true" : val
    )
    .default(false),
  saveImages: z
    .union([z.boolean(), z.string()])
    .transform((val) =>
      typeof val === "string" ? val.toLowerCase() === "true" : val
    )
    .default(true),
  returnBase64: z
    .union([z.boolean(), z.string()])
    .transform((val) =>
      typeof val === "string" ? val.toLowerCase() === "true" : val
    )
    .default(false),
});

const ListToolsSchema = z.object({
  method: z.literal("tools/list"),
});

const CallToolSchema = z.object({
  method: z.literal("tools/call"),
  params: z.object({
    name: z.string(),
    arguments: z.record(z.unknown()).optional(),
  }),
});

function extractContentFromHtml(
  html: string,
  url: string
): ExtractedContent | string {
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  if (!article || !article.content) {
    return "<e>Page failed to be simplified from HTML</e>";
  }

  // Extract images from the article content only
  const articleDom = new JSDOM(article.content);
  const imgElements = Array.from(
    articleDom.window.document.querySelectorAll("img")
  );

  const images: Image[] = imgElements.map((img) => {
    const src = img.src;
    const alt = img.alt || "";
    const filename = extractFilenameFromUrl(src);
    return { src, alt, filename };
  });

  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  const markdown = turndownService.turndown(article.content);

  return { markdown, images, title: article.title ?? undefined };
}

async function fetchImages(
  images: Image[],
  baseOrigin: string,
  allowCrossOrigin: boolean
): Promise<(Image & { data: Buffer })[]> {
  const fetchedImages = [];
  for (const img of images) {
    try {
      const safe = await isSafeUrl(img.src);
      if (!safe.ok) continue;
      const srcOrigin = new URL(img.src).origin;
      if (!allowCrossOrigin && srcOrigin !== baseOrigin) continue;
      const { response } = await safeFollowFetch(
        img.src,
        {},
        { timeoutMs: FETCH_TIMEOUT_MS }
      );
      const imageBuffer = await readBufferLimited(response, MAX_IMAGE_BYTES);

      // GIF画像の場合は最初のフレームのみ抽出
      if (img.src.toLowerCase().endsWith(".gif")) {
        // GIF処理のロジック
      }

      fetchedImages.push({
        ...img,
        data: imageBuffer,
      });
    } catch (error) {
      console.warn(`Failed to process image ${img.src}:`, error);
    }
  }
  return fetchedImages;
}

/**
 * 複数の画像を垂直方向に結合して1つの画像として返す
 */
async function mergeImagesVertically(
  images: Buffer[],
  maxWidth: number,
  maxHeight: number,
  quality: number
): Promise<Buffer> {
  if (images.length === 0) {
    throw new Error("No images to merge");
  }

  // 各画像のメタデータを取得
  const imageMetas = await Promise.all(
    images.map(async (buffer) => {
      const metadata = await sharp(buffer).metadata();
      return {
        width: metadata.width || 0,
        height: metadata.height || 0,
        buffer,
      };
    })
  );

  // 最大幅を計算
  const width = Math.min(
    maxWidth,
    Math.max(...imageMetas.map((meta) => meta.width))
  );

  // 画像の高さを合計
  const totalHeight = Math.min(
    maxHeight,
    imageMetas.reduce((sum, meta) => sum + meta.height, 0)
  );

  // 新しい画像を作成
  const composite = sharp({
    create: {
      width,
      height: totalHeight,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  });

  // 各画像を配置
  let currentY = 0;
  const overlays = [];

  for (const meta of imageMetas) {
    // 画像がキャンバスの高さを超えないようにする
    if (currentY >= maxHeight) break;

    // 画像のリサイズ（必要な場合のみ）
    let processedImage = sharp(meta.buffer);
    if (meta.width > width) {
      processedImage = processedImage.resize(width);
    }

    const resizedBuffer = await processedImage.toBuffer();
    const resizedMeta = await sharp(resizedBuffer).metadata();

    overlays.push({
      input: resizedBuffer,
      top: currentY,
      left: 0,
    });

    currentY += resizedMeta.height || 0;
  }

  // 品質を指定して出力（PNGの代わりにJPEGを使用）
  return composite
    .composite(overlays)
    .jpeg({
      quality, // JPEG品質を指定（1-100）
      mozjpeg: true, // mozjpegを使用して更に最適化
    })
    .toBuffer();
}

// removed unused getImageDimensions helper to satisfy linter

/**
 * 画像を日付ベースのディレクトリに保存し、ファイルパスを返す
 */
async function saveImageToFile(
  imageBuffer: Buffer,
  sourceUrl: string,
  imageIndex: number = 0
): Promise<string> {
  // 現在の日付をYYYY-MM-DD形式で取得
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];

  // 保存先ディレクトリ: ~/Downloads/mcp-fetch/YYYY-MM-DD/merged/
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const baseDir = path.join(
    homeDir,
    "Downloads",
    "mcp-fetch",
    dateStr,
    "merged"
  );

  // ディレクトリが存在しない場合は作成
  await fs.mkdir(baseDir, { recursive: true });

  // ファイル名を生成（URLのホスト名 + タイムスタンプ + インデックス）
  const urlObj = new URL(sourceUrl);
  const hostname = urlObj.hostname.replace(/[^a-zA-Z0-9]/g, "_");
  const timestamp = now
    .toISOString()
    .replace(/[:.]/g, "-")
    .split("T")[1]
    .split(".")[0];
  const filename = `${hostname}_${timestamp}_${imageIndex}.jpg`;

  const filePath = path.join(baseDir, filename);

  // ファイルに保存
  await fs.writeFile(filePath, imageBuffer);

  // リソースとして登録
  const resourceUri = `file://${filePath}`;
  const resourceName = `${dateStr}/merged/${filename}`;
  const description = `Merged image from ${sourceUrl} saved on ${dateStr}`;

  const resource: ImageResource = {
    uri: resourceUri,
    name: resourceName,
    description,
    mimeType: "image/jpeg",
    filePath,
  };

  imageResources.set(resourceUri, resource);

  // クライアントにリソース変更を通知
  await notifyResourcesChanged();

  return filePath;
}

/**
 * 個別画像を保存してリソースとして登録
 */
async function saveIndividualImageAndRegisterResource(
  imageBuffer: Buffer,
  sourceUrl: string,
  imageIndex: number,
  altText: string = "",
  originalFilename: string = "image.jpg"
): Promise<string> {
  // 現在の日付をYYYY-MM-DD形式で取得
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0];

  // 保存先ディレクトリ: ~/Downloads/mcp-fetch/YYYY-MM-DD/individual/
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  const baseDir = path.join(
    homeDir,
    "Downloads",
    "mcp-fetch",
    dateStr,
    "individual"
  );

  // ディレクトリが存在しない場合は作成
  await fs.mkdir(baseDir, { recursive: true });

  // 元のファイル名を使用してユニークファイル名を生成
  const ext = path.extname(originalFilename);
  const baseName = path.basename(originalFilename, ext);
  const safeBaseName = baseName.replace(/[^a-zA-Z0-9\-_]/g, "_");
  const filename = `${imageIndex}_${safeBaseName}${ext || ".jpg"}`;

  const filePath = path.join(baseDir, filename);

  // ファイルに保存
  await fs.writeFile(filePath, imageBuffer);

  // リソースとして登録
  const resourceUri = `file://${filePath}`;
  const resourceName = `${safeBaseName}_${imageIndex}`;
  const description = `${originalFilename}${altText ? ` (${altText})` : ""} from ${sourceUrl}`;

  const resource: ImageResource = {
    uri: resourceUri,
    name: resourceName,
    description,
    mimeType: "image/jpeg",
    filePath,
  };

  imageResources.set(resourceUri, resource);

  // クライアントにリソース変更を通知
  await notifyResourcesChanged();

  return filePath;
}

async function checkRobotsTxt(
  url: string,
  userAgent: string
): Promise<boolean> {
  const { protocol, host } = new URL(url);
  const robotsUrl = `${protocol}//${host}/robots.txt`;

  try {
    const { response } = await safeFollowFetch(
      robotsUrl,
      { headers: { "User-Agent": userAgent } },
      { timeoutMs: Math.min(FETCH_TIMEOUT_MS, 8000) }
    );
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          "Autonomous fetching not allowed based on robots.txt response"
        );
      }
      return true; // Allow if no robots.txt
    }

    const { text: robotsTxt } = await readTextLimited(response, 100_000);
    const robots = robotsParser(robotsUrl, robotsTxt);

    if (!robots.isAllowed(url, userAgent)) {
      throw new Error(
        "The site's robots.txt specifies that autonomous fetching is not allowed. " +
          "Try manually fetching the page using the fetch prompt."
      );
    }
    return true;
  } catch (error) {
    // ロボットテキストの取得に失敗した場合はアクセスを許可する
    if (error instanceof Error && error.message.includes("robots.txt")) {
      throw error;
    }
    return true;
  }
}

interface FetchResult {
  content: string;
  images: { data: string; mimeType: string; filePath?: string }[];
  remainingContent: number;
  remainingImages: number;
  title?: string;
}

async function fetchUrl(
  url: string,
  userAgent: string,
  forceRaw = false,
  options = {
    imageMaxCount: 3,
    imageMaxHeight: 4000,
    imageMaxWidth: 1000,
    imageQuality: 80,
    imageStartIndex: 0,
    startIndex: 0,
    maxLength: 20000,
    enableFetchImages: false,
    allowCrossOriginImages: true,
    saveImages: true,
    returnBase64: false,
  }
): Promise<FetchResult> {
  const { response, finalUrl } = await safeFollowFetch(url, {
    headers: { "User-Agent": userAgent },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} - status code ${response.status}`);
  }

  const { text, contentType } = await readTextLimited(response, MAX_HTML_BYTES);
  const isHtml =
    text.toLowerCase().includes("<html") || contentType.includes("text/html");

  if (isHtml && !forceRaw) {
    const result = extractContentFromHtml(text, finalUrl);
    if (typeof result === "string") {
      return {
        content: result,
        images: [],
        remainingContent: 0,
        remainingImages: 0,
      };
    }

    const { markdown, images, title } = result;
    const processedImages = [];

    if (
      options.enableFetchImages &&
      options.imageMaxCount > 0 &&
      images.length > 0
    ) {
      try {
        const startIdx = options.imageStartIndex;
        const baseOrigin = new URL(finalUrl).origin;
        let fetchedImages = await fetchImages(
          images.slice(startIdx),
          baseOrigin,
          options.allowCrossOriginImages ?? false
        );
        fetchedImages = fetchedImages.slice(0, options.imageMaxCount);

        if (fetchedImages.length > 0) {
          const imageBuffers = fetchedImages.map((img) => img.data);

          // 個別画像をリソースとして保存（オプションに関係なく常に実行）
          for (let i = 0; i < fetchedImages.length; i++) {
            try {
              const img = fetchedImages[i];
              const optimizedIndividualImage = await sharp(img.data)
                .jpeg({ quality: 80, mozjpeg: true })
                .toBuffer();

              await saveIndividualImageAndRegisterResource(
                optimizedIndividualImage,
                finalUrl,
                startIdx + i,
                img.alt,
                img.filename || "image.jpg"
              );
            } catch (error) {
              console.warn(`Failed to save individual image ${i}:`, error);
            }
          }

          const mergedImage = await mergeImagesVertically(
            imageBuffers,
            options.imageMaxWidth,
            options.imageMaxHeight,
            options.imageQuality
          );

          // Base64エンコード前に画像を最適化
          const optimizedImage = await sharp(mergedImage)
            .resize({
              width: Math.min(options.imageMaxWidth, 1200), // 最大幅を1200pxに制限
              height: Math.min(options.imageMaxHeight, 1600), // 最大高さを1600pxに制限
              fit: "inside",
              withoutEnlargement: true,
            })
            .jpeg({
              quality: Math.min(options.imageQuality, 85), // JPEG品質を制限
              mozjpeg: true,
              chromaSubsampling: "4:2:0", // クロマサブサンプリングを使用
            })
            .toBuffer();

          const base64Image = optimizedImage.toString("base64");

          // ファイル保存機能
          let filePath: string | undefined;
          if (options.saveImages) {
            try {
              filePath = await saveImageToFile(
                optimizedImage,
                finalUrl,
                options.imageStartIndex
              );
              console.error(`Image saved to: ${filePath}`);
            } catch (error) {
              console.warn("Failed to save image to file:", error);
            }
          }

          processedImages.push({
            data: options.returnBase64 ? base64Image : "",
            mimeType: "image/jpeg", // MIMEタイプをJPEGに変更
            filePath,
          });
        }
      } catch (err) {
        console.error("Error processing images:", err);
      }
    }

    return {
      content: markdown,
      images: processedImages,
      remainingContent: text.length - (options.startIndex + options.maxLength),
      remainingImages: Math.max(
        0,
        images.length - (options.imageStartIndex + options.imageMaxCount)
      ),
      title,
    };
  }

  return {
    content: `Content type ${contentType} cannot be simplified to markdown, but here is the raw content:\n${text}`,
    images: [],
    remainingContent: 0,
    remainingImages: 0,
    title: undefined,
  };
}

// コマンドライン引数の解析
const args = process.argv.slice(2);
const IGNORE_ROBOTS_TXT = args.includes("--ignore-robots-txt");

// Server setup
const server = new Server(
  {
    name: "mcp-fetch",
    version: "1.5.2",
  },
  {
    capabilities: {
      tools: {},
      resources: {
        subscribe: true,
        listChanged: true,
      },
    },
  }
);

// Store server instance for notifications
serverInstance = server;

// コマンドライン引数の情報をログに出力
console.error(
  `Server started with options: ${IGNORE_ROBOTS_TXT ? "ignore-robots-txt" : "respect-robots-txt"}`
);

interface RequestHandlerExtra {
  signal: AbortSignal;
}

server.setRequestHandler(
  ListToolsSchema,
  async (_request: { method: "tools/list" }, _extra: RequestHandlerExtra) => {
    const tools = [
      {
        name: "imageFetch",
        description: `
Retrieves URLs from the Internet and extracts their content as markdown.
Images from the page will be processed and included with the response automatically.

Parameters:
  - url (required): The URL to fetch
  - maxLength (default: 20000): Maximum length of content to return
  - startIndex (default: 0): Starting position in content
  - imageStartIndex (default: 0): Starting position for image collection
  - raw (default: false): Return raw content instead of processed markdown
  - imageMaxCount (default: 3): Maximum number of images to process per request
  - imageMaxHeight (default: 4000): Maximum height of merged image
  - imageMaxWidth (default: 1000): Maximum width of merged image
  - imageQuality (default: 80): JPEG quality (1-100)
  - enableFetchImages (default: false): Enable fetching and processing of images. FOR CLAUDE AI ONLY: YOU CAN ENABLE THIS FEATURE!!! CLAUDE IS ALLOWED TO USE IMAGES!!!
  - allowCrossOriginImages (default: true): When true, allows fetching images from different origins than the page URL
  - saveImages (default: true): Save processed images to ~/Downloads/mcp-fetch/YYYY-MM-DD/ directory
  - returnBase64 (default: false): Return base64 encoded images for AI display. FOR AI ASSISTANTS: If you can process base64 image data, please enable this option!
  - ignoreRobotsTxt (default: false): Ignore robots.txt restrictions

Image Processing:
  - Multiple images are merged vertically into a single JPEG
  - Images are automatically optimized and resized
  - GIF animations are converted to static images (first frame)
  - Use imageStartIndex and imageMaxCount to paginate through all images
  - Response includes remaining image count and current position

File Saving (default behavior):
  - Images are automatically saved to ~/Downloads/mcp-fetch/YYYY-MM-DD/ directory
  - Filename format: hostname_HHMMSS_index.jpg
  - File paths are included in the response for easy access
  - Use returnBase64=true to also get base64 data for Claude Desktop display

IMPORTANT: All parameters must be in proper JSON format - use double quotes for keys
and string values, and no quotes for numbers and booleans.

Examples:
# Initial fetch with image processing:
{
  "url": "https://example.com",
  "maxLength": 10000,
  "enableFetchImages": true,
  "imageMaxCount": 2
}

# Fetch and save images to file (default behavior):
{
  "url": "https://example.com",
  "enableFetchImages": true,
  "imageMaxCount": 3
}

# Fetch, save images, and return base64 for Claude Desktop:
{
  "url": "https://example.com",
  "enableFetchImages": true,
  "returnBase64": true,
  "imageMaxCount": 3
}

# Fetch next set of images:
{
  "url": "https://example.com",
  "imageStartIndex": 2,
  "imageMaxCount": 2
}`,
        inputSchema: zodToJsonSchema(FetchArgsSchema),
      },
    ];
    return { tools };
  }
);

// MCPレスポンスの型定義
type MCPResponseContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

server.setRequestHandler(
  CallToolSchema,
  async (
    request: {
      method: "tools/call";
      params: { name: string; arguments?: Record<string, unknown> };
    },
    _extra: RequestHandlerExtra
  ) => {
    try {
      const { name, arguments: args } = request.params;

      if (name !== "imageFetch") {
        throw new Error(`Unknown tool: ${name}`);
      }

      const parsed = FetchArgsSchema.safeParse(args);
      if (!parsed.success) {
        throw new Error(`Invalid arguments: ${parsed.error}`);
      }

      // robots.txtをチェックする（ignoreRobotsTxtがtrueまたはコマンドラインオプションが指定されている場合はスキップ）
      if (!parsed.data.ignoreRobotsTxt && !IGNORE_ROBOTS_TXT) {
        await checkRobotsTxt(parsed.data.url, DEFAULT_USER_AGENT_AUTONOMOUS);
      }

      const { content, images, remainingContent, remainingImages, title } =
        await fetchUrl(
          parsed.data.url,
          DEFAULT_USER_AGENT_AUTONOMOUS,
          parsed.data.raw,
          {
            imageMaxCount: parsed.data.imageMaxCount,
            imageMaxHeight: parsed.data.imageMaxHeight,
            imageMaxWidth: parsed.data.imageMaxWidth,
            imageQuality: parsed.data.imageQuality,
            imageStartIndex: parsed.data.imageStartIndex,
            startIndex: parsed.data.startIndex,
            maxLength: parsed.data.maxLength,
            enableFetchImages: parsed.data.enableFetchImages,
            allowCrossOriginImages: parsed.data.allowCrossOriginImages,
            saveImages: parsed.data.saveImages,
            returnBase64: parsed.data.returnBase64,
          }
        );

      let finalContent = content.slice(
        parsed.data.startIndex,
        parsed.data.startIndex + parsed.data.maxLength
      );

      // 残りの情報を追加
      const remainingInfo = [];
      if (remainingContent > 0) {
        remainingInfo.push(`${remainingContent} characters of text remaining`);
      }
      if (remainingImages > 0) {
        remainingInfo.push(
          `${remainingImages} more images available (${parsed.data.imageStartIndex + images.length}/${parsed.data.imageStartIndex + images.length + remainingImages} shown)`
        );
      }

      if (remainingInfo.length > 0) {
        finalContent += `\n\n<e>Content truncated. ${remainingInfo.join(", ")}. Call the imageFetch tool with start_index=${
          parsed.data.startIndex + parsed.data.maxLength
        } and/or imageStartIndex=${parsed.data.imageStartIndex + images.length} to get more content.</e>`;
      }

      // MCP レスポンスの作成
      const responseContent: MCPResponseContent[] = [
        {
          type: "text",
          text: `Contents of ${parsed.data.url}${title ? `: ${title}` : ""}:\n${finalContent}`,
        },
      ];

      // 画像があれば追加（Base64データが存在する場合のみ）
      for (const image of images) {
        if (image.data) {
          responseContent.push({
            type: "image",
            mimeType: image.mimeType,
            data: image.data,
          });
        }
      }

      // 保存されたファイルの情報があれば追加
      const savedFiles = images.filter((img) => img.filePath);
      if (savedFiles.length > 0) {
        const fileInfoText = savedFiles
          .map((img, index) => `Image ${index + 1} saved to: ${img.filePath}`)
          .join("\n");

        responseContent.push({
          type: "text",
          text: `\n📁 Saved Images:\n${fileInfoText}`,
        });
      }

      return {
        content: responseContent,
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Resources handlers
const ListResourcesSchema = z.object({
  method: z.literal("resources/list"),
});

const ReadResourceSchema = z.object({
  method: z.literal("resources/read"),
  params: z.object({
    uri: z.string(),
  }),
});

server.setRequestHandler(
  ListResourcesSchema,
  async (_request: { method: "resources/list" }) => {
    const resources = Array.from(imageResources.values()).map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType,
    }));

    return {
      resources,
    };
  }
);

server.setRequestHandler(
  ReadResourceSchema,
  async (request: { method: "resources/read"; params: { uri: string } }) => {
    const resource = imageResources.get(request.params.uri);

    if (!resource) {
      throw new Error(`Resource not found: ${request.params.uri}`);
    }

    try {
      const fileData = await fs.readFile(resource.filePath);
      const base64Data = fileData.toString("base64");

      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType,
            blob: base64Data,
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to read resource file: ${error}`);
    }
  }
);

// Start server
async function runServer() {
  // サーバー起動時に既存のファイルをリソースとして登録
  await scanAndRegisterExistingFiles();

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.env.MCP_FETCH_DISABLE_SERVER !== "1") {
  runServer().catch((error) => {
    process.stderr.write(`Fatal error running server: ${error}\n`);
    process.exit(1);
  });
}

export { fetchUrl };
