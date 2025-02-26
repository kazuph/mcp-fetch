#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type {
  CallToolRequest,
  ListToolsRequest,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";
import robotsParser from "robots-parser";
import sharp from "sharp";

interface Image {
  src: string;
  alt: string;
  data?: Buffer;
}

interface ExtractedContent {
  markdown: string;
  images: Image[];
  title?: string;
}

const DEFAULT_USER_AGENT_AUTONOMOUS =
  "ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)";
const DEFAULT_USER_AGENT_MANUAL =
  "ModelContextProtocol/1.0 (User-Specified; +https://github.com/modelcontextprotocol/servers)";

const FetchArgsSchema = z.object({
  url: z.string().url(),
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
  disableImages: z
    .union([z.boolean(), z.string()])
    .transform((val) =>
      typeof val === "string" ? val.toLowerCase() === "true" : val
    )
    .default(false),
  ignoreRobotsTxt: z
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
    return { src, alt };
  });

  const turndownService = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });
  const markdown = turndownService.turndown(article.content);

  return { markdown, images, title: article.title };
}

async function fetchImages(
  images: Image[]
): Promise<(Image & { data: Buffer })[]> {
  const fetchedImages = [];
  for (const img of images) {
    try {
      const response = await fetch(img.src);
      const buffer = await response.arrayBuffer();
      const imageBuffer = Buffer.from(buffer);

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

async function getImageDimensions(
  buffer: Buffer
): Promise<{ width: number; height: number; size: number }> {
  const metadata = await sharp(buffer).metadata();
  return {
    width: metadata.width || 0,
    height: metadata.height || 0,
    size: buffer.length,
  };
}

async function checkRobotsTxt(
  url: string,
  userAgent: string
): Promise<boolean> {
  const { protocol, host } = new URL(url);
  const robotsUrl = `${protocol}//${host}/robots.txt`;

  try {
    const response = await fetch(robotsUrl);
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          "Autonomous fetching not allowed based on robots.txt response"
        );
      }
      return true; // Allow if no robots.txt
    }

    const robotsTxt = await response.text();
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
  images: { data: string; mimeType: string }[];
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
    disableImages: false,
    imageStartIndex: 0,
    startIndex: 0,
    maxLength: 20000,
  }
): Promise<FetchResult> {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url} - status code ${response.status}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();
  const isHtml =
    text.toLowerCase().includes("<html") || contentType.includes("text/html");

  if (isHtml && !forceRaw) {
    const result = extractContentFromHtml(text, url);
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
      !options.disableImages &&
      options.imageMaxCount > 0 &&
      images.length > 0
    ) {
      try {
        const startIdx = options.imageStartIndex;
        let fetchedImages = await fetchImages(images.slice(startIdx));
        fetchedImages = fetchedImages.slice(0, options.imageMaxCount);

        if (fetchedImages.length > 0) {
          const imageBuffers = fetchedImages.map((img) => img.data);

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

          processedImages.push({
            data: base64Image,
            mimeType: "image/jpeg", // MIMEタイプをJPEGに変更
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
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// コマンドライン引数の情報をログに出力
console.error(
  `Server started with options: ${IGNORE_ROBOTS_TXT ? "ignore-robots-txt" : "respect-robots-txt"}`
);

interface RequestHandlerExtra {
  signal: AbortSignal;
}

server.setRequestHandler(
  ListToolsSchema,
  async (request: { method: "tools/list" }, extra: RequestHandlerExtra) => {
    const tools = [
      {
        name: "fetch",
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
  - disableImages (default: false): Skip image processing
  - ignoreRobotsTxt (default: false): Ignore robots.txt restrictions

AI Assistant Usage:
  - If you are using Claude: You can retrieve images directly
  - If you are using Cursor or Cline: Set disableImages: true as these clients don't support MCP image retrieval

Image Processing:
  - Multiple images are merged vertically into a single JPEG
  - Images are automatically optimized and resized
  - GIF animations are converted to static images (first frame)
  - Use imageStartIndex and imageMaxCount to paginate through all images
  - Response includes remaining image count and current position

IMPORTANT: All parameters must be in proper JSON format - use double quotes for keys
and string values, and no quotes for numbers and booleans.

Examples:
# Initial fetch:
{
  "url": "https://example.com",
  "maxLength": 10000,
  "imageMaxCount": 2
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
    extra: RequestHandlerExtra
  ) => {
    try {
      const { name, arguments: args } = request.params;

      if (name !== "fetch") {
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
            disableImages: parsed.data.disableImages,
            imageStartIndex: parsed.data.imageStartIndex,
            startIndex: parsed.data.startIndex,
            maxLength: parsed.data.maxLength,
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
        finalContent += `\n\n<e>Content truncated. ${remainingInfo.join(", ")}. Call the fetch tool with start_index=${
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

      // 画像があれば追加
      for (const image of images) {
        responseContent.push({
          type: "image",
          mimeType: image.mimeType,
          data: image.data,
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

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

runServer().catch((error) => {
  process.stderr.write(`Fatal error running server: ${error}\n`);
  process.exit(1);
});
