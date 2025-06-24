# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**mcp-fetch** is a Model Context Protocol (MCP) server that provides web content fetching capabilities for AI assistants. It converts HTML pages to clean markdown using Mozilla Readability and optionally processes images using Sharp.

## Development Commands

```bash
# Build TypeScript to JavaScript
npm run build

# Type checking only (recommended before commits)
npm run typecheck

# Run all quality checks (biome linting + typecheck)
npm test

# Format code using Biome
npm run format

# Lint code using Biome
npm run lint

# Build and run the server
npm run dev

# Run the compiled server
npm start
```

## Architecture

### Single-File Design
- **Core logic**: All functionality is in `index.ts` (606 lines)
- **Type definitions**: External module types in `types.d.ts`
- This is intentional - the tool has focused scope and benefits from centralized logic

### Key Components
- **MCP Server**: Uses `@modelcontextprotocol/sdk` for protocol implementation
- **Content Pipeline**: HTML → Readability → Markdown → Pagination
- **Image Pipeline**: Fetch → JPEG conversion → Vertical merging → File saving → Optional Base64 encoding
- **Parameter Validation**: Zod schemas with automatic type conversion from string/number unions

### Dependencies Architecture
- **Content Processing**: `@mozilla/readability` + `jsdom` + `turndown` chain
- **Image Processing**: `sharp` for high-performance image operations
- **HTTP**: `node-fetch` for web requests
- **Compliance**: `robots-parser` for robots.txt checking

## Code Patterns

### Parameter Handling
Parameters use union types (`string | number`) with Zod validation for automatic type conversion:

```typescript
url: z.string(),
maxLength: z.union([z.string(), z.number()]).transform(Number).default(20000),
enableFetchImages: z.union([z.string(), z.boolean()]).transform(toBool).default(false)
```

### Error Handling
Network operations include comprehensive error handling with specific error types for different failure scenarios.

### Image Optimization and File Saving
- Images are always converted to JPEG format with configurable quality (default 80)
- Multiple images are merged vertically when present
- **Default behavior**: Images are automatically saved to `~/Downloads/mcp-fetch/YYYY-MM-DD/` directory
- **Optional**: Base64 encoding for Claude Desktop display (enabled with `returnBase64: true`)
- **Filename format**: `hostname_HHMMSS_index.jpg`

## Configuration

### Biome (Linting/Formatting)
- 2-space indentation
- Double quotes
- 80-character line width
- ES5 trailing commas
- Uses modern Biome instead of ESLint + Prettier

### TypeScript
- Target: ES2022
- Module: NodeNext (ESM)
- Strict mode enabled
- Output: `./dist`

## Testing Strategy

Current approach relies on:
1. TypeScript compilation as primary validation
2. Biome for code quality
3. Manual testing via Claude Desktop integration

**Note**: No unit tests are currently implemented. The `npm test` command runs typecheck + biome checks only.

## Deployment

The tool is designed for npx usage:
```bash
npx -y @kazuph/mcp-fetch
```

For Claude Desktop integration, add to MCP tools configuration:
```json
{
  "tools": {
    "imageFetch": {
      "command": "npx",
      "args": ["-y", "@kazuph/mcp-fetch"]
    }
  }
}
```

## Important Implementation Details

### Platform Specificity
- Designed for macOS (mentioned in README)
- Sharp binaries include Darwin ARM64 support

### Content Processing Limits
- Default maxLength: 20,000 characters
- Supports pagination via startIndex parameter
- Image processing disabled by default (performance consideration)

### Robots.txt Compliance
- Enabled by default for ethical web scraping
- Can be disabled with `ignoreRobotsTxt: true` parameter

## Common Development Workflow

1. Make code changes in `index.ts`
2. Run `npm run typecheck` to verify TypeScript
3. Run `npm run format` to ensure consistent formatting
4. Run `npm test` to run all validations
5. Test manually with `npm run dev` or via Claude Desktop integration