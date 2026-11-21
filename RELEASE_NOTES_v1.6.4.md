# v1.6.4

Hardens the shared HTTP request guard used for page and image fetching.

- Rejects non-public destinations before requests, including across redirects.
- Adds offline regression coverage for destination validation.
