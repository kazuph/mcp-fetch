# v1.5.2 — Fix: restore cross‑origin image fetching by default

Release date: 2025-09-24

## Fixed
- Regression in v1.5.1 where images hosted on different origins (e.g. CDNs) were blocked by default.
  - `allowCrossOriginImages` default is restored to `true` for backwards compatibility.

## Added
- Unit tests (Vitest) to verify that:
  - Base64 image data is returned when requested
  - Images are saved to disk when enabled
  - Cross-origin images are blocked when `allowCrossOriginImages: false`

## Security
- v1.5.1 hardening (SSRF guard, timeouts, redirect limits, size limits) remains in place.

