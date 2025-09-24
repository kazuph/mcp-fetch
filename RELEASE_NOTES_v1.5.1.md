# v1.5.1 — Security hardening and safe fetch improvements

Release date: 2025-09-24

## Highlights
- Strong SSRF and DoS protections:
  - Only `http://` and `https://` URLs are allowed (pages and images)
  - Block loopback, private, link-local and multicast IPs; block `localhost`/`.local` hostnames
  - DNS resolution is checked to prevent private IPs via DNS
  - Manual redirect handling with validation (max 3 hops)
  - Request timeout (default 12s)
  - Response size limits: HTML up to 2MB, images up to 10MB
- robots.txt fetch now uses the same safe pipeline and is size-limited
- Same-origin image fetching by default; cross-origin can be explicitly enabled

## Added
- `allowCrossOriginImages` (boolean, default `false`) to fetch images from different origins when needed.

## Changed
- Default image policy is same-origin only for defense in depth.

## Configuration (env vars)
- `MCP_FETCH_TIMEOUT_MS` (default: `12000`)
- `MCP_FETCH_MAX_REDIRECTS` (default: `3`)
- `MCP_FETCH_MAX_HTML_BYTES` (default: `2000000`)
- `MCP_FETCH_MAX_IMAGE_BYTES` (default: `10000000`)

## Docs & QA
- README updated with Security Hardening and env vars
- Typecheck/build/audit: all passing; Biome lint/format integrated

## Compatibility notes
- No breaking API changes. If your pages rely on CDN or third-party image hosts, pass `allowCrossOriginImages: true` in tool arguments.

