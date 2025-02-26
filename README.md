# MCP Fetch

Model Context Protocol server for fetching web content and processing images. This allows Claude Desktop (or any MCP client) to fetch web content and handle images appropriately.

<a href="https://glama.ai/mcp/servers/5mknfdhyrg"><img width="380" height="200" src="https://glama.ai/mcp/servers/5mknfdhyrg/badge" alt="@kazuph/mcp-fetch MCP server" /></a>

## Quick Start (For Users)

To use this tool with Claude Desktop, simply add the following to your Claude Desktop configuration (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "tools": {
    "fetch": {
      "command": "npx",
      "args": ["-y", "@kazuph/mcp-fetch"]
    }
  }
}
```

This will automatically download and run the latest version of the tool when needed.

### Required Setup

1. Enable Accessibility for Claude:
   - Open System Settings
   - Go to Privacy & Security > Accessibility
   - Click the "+" button
   - Add Claude from your Applications folder
   - Turn ON the toggle for Claude

This accessibility setting is required for automated clipboard operations (Cmd+V) to work properly.

## Features

- **Web Content Extraction**: Automatically extracts and formats web content as markdown
- **Image Processing**: Processes images from web pages and optimizes them
- **Pagination Support**: Supports pagination for both text and images
- **JPEG Optimization**: Automatically optimizes images as JPEG for better performance
- **GIF Support**: Extracts first frame from animated GIFs

## For Developers

The following sections are for those who want to develop or modify the tool.

## Prerequisites

- Node.js 18+
- macOS (for clipboard operations)
- Claude Desktop (install from https://claude.ai/desktop)
- tsx (install via `npm install -g tsx`)

## Installation

```bash
git clone https://github.com/kazuph/mcp-fetch.git
cd mcp-fetch
npm install
npm run build
```

## Image Processing Specifications

When processing images from web content, the following optimizations are applied:

- Images are converted to JPEG format with quality control
- Maximum width limited to 1200px by default
- Maximum height limited to 1600px by default
- Chroma subsampling (4:2:0) for better compression
- MozJPEG optimization for smaller file sizes

## Configuration

1. Make sure Claude Desktop is installed and running.

2. Install tsx globally if you haven't:
```bash
npm install -g tsx
# or
pnpm add -g tsx
```

3. Modify your Claude Desktop config located at:
`~/Library/Application Support/Claude/claude_desktop_config.json`

You can easily find this through the Claude Desktop menu:
1. Open Claude Desktop
2. Click Claude on the Mac menu bar
3. Click "Settings"
4. Click "Developer"

Add the following to your MCP client's configuration:

```json
{
  "tools": {
    "fetch": {
      "args": ["tsx", "/path/to/mcp-fetch/index.ts"]
    }
  }
}
```

## Available Parameters

- `url` (required): The URL to fetch
- `maxLength` (default: 20000): Maximum length of content to return
- `startIndex` (default: 0): Starting position in content
- `imageStartIndex` (default: 0): Starting position for image collection
- `raw` (default: false): Return raw content instead of processed markdown
- `imageMaxCount` (default: 3): Maximum number of images to process per request
- `imageMaxHeight` (default: 4000): Maximum height of merged image
- `imageMaxWidth` (default: 1000): Maximum width of merged image
- `imageQuality` (default: 80): JPEG quality (1-100)
- `disableImages` (default: false): Skip image processing
- `ignoreRobotsTxt` (default: false): Ignore robots.txt restrictions

## Notes

- This tool is designed for macOS only due to its dependency on macOS-specific clipboard operations.
- Images are processed using Sharp for optimal performance and quality.
- When multiple images are found, they are merged vertically with consideration for size limits.
- Animated GIFs are automatically handled by extracting their first frame.
