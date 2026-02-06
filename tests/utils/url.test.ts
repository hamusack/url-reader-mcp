/**
 * @fileoverview Tests for URL utility functions.
 *
 * Covers: normalizeUrl, extractDomain, resolveUrl, matchesPattern,
 * isDomainAllowed, isFetchableUrl.
 */

import { describe, it, expect } from "bun:test";
import {
  normalizeUrl,
  extractDomain,
  resolveUrl,
  matchesPattern,
  isDomainAllowed,
  isFetchableUrl,
} from "../../src/utils/url.js";

// ---------------------------------------------------------------------------
// normalizeUrl
// ---------------------------------------------------------------------------

describe("normalizeUrl", () => {
  it("removes fragment identifiers", () => {
    const result = normalizeUrl("https://example.com/page#section");
    expect(result).toBe("https://example.com/page");
  });

  it("removes fragment from root URL", () => {
    const result = normalizeUrl("https://example.com/#top");
    expect(result).toBe("https://example.com");
  });

  it("strips trailing slash on root path without query params", () => {
    const result = normalizeUrl("https://example.com/");
    expect(result).toBe("https://example.com");
  });

  it("preserves trailing slash on deeper paths", () => {
    const result = normalizeUrl("https://example.com/blog/");
    expect(result).toBe("https://example.com/blog/");
  });

  it("sorts query parameters alphabetically by key", () => {
    const result = normalizeUrl("https://example.com/path?z=3&a=1&m=2");
    expect(result).toBe("https://example.com/path?a=1&m=2&z=3");
  });

  it("removes default port 80 for http", () => {
    const result = normalizeUrl("http://example.com:80/page");
    expect(result).toBe("http://example.com/page");
  });

  it("removes default port 443 for https", () => {
    const result = normalizeUrl("https://example.com:443/page");
    expect(result).toBe("https://example.com/page");
  });

  it("preserves non-default ports", () => {
    const result = normalizeUrl("https://example.com:8080/page");
    expect(result).toBe("https://example.com:8080/page");
  });

  it("lowercases scheme and host", () => {
    const result = normalizeUrl("HTTPS://Example.COM/Path");
    expect(result).toBe("https://example.com/Path");
  });

  it("applies all normalization rules together", () => {
    const result = normalizeUrl(
      "HTTPS://Example.COM:443/path?b=2&a=1#section",
    );
    expect(result).toBe("https://example.com/path?a=1&b=2");
  });

  it("throws on invalid URL", () => {
    expect(() => normalizeUrl("not-a-valid-url")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractDomain
// ---------------------------------------------------------------------------

describe("extractDomain", () => {
  it("extracts domain from a simple URL", () => {
    expect(extractDomain("https://example.com/page")).toBe("example.com");
  });

  it("extracts domain with port (port is excluded from hostname)", () => {
    expect(extractDomain("https://example.com:8080/page")).toBe("example.com");
  });

  it("extracts subdomain", () => {
    expect(extractDomain("https://sub.example.com/page")).toBe(
      "sub.example.com",
    );
  });

  it("lowercases the hostname", () => {
    expect(extractDomain("https://Sub.EXAMPLE.Com/page")).toBe(
      "sub.example.com",
    );
  });

  it("handles localhost", () => {
    expect(extractDomain("http://localhost:3000/api")).toBe("localhost");
  });

  it("throws on invalid URL", () => {
    expect(() => extractDomain("not-a-url")).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveUrl
// ---------------------------------------------------------------------------

describe("resolveUrl", () => {
  it("resolves an absolute path against a base URL", () => {
    const result = resolveUrl("https://example.com/docs/intro", "/about");
    expect(result).toBe("https://example.com/about");
  });

  it("resolves a relative path (parent traversal) against a base URL", () => {
    const result = resolveUrl("https://example.com/docs/intro", "../blog");
    expect(result).toBe("https://example.com/blog");
  });

  it("returns the absolute URL when relative is already absolute", () => {
    const result = resolveUrl(
      "https://example.com/docs/intro",
      "https://other.com/page",
    );
    expect(result).toBe("https://other.com/page");
  });

  it("resolves protocol-relative URLs", () => {
    const result = resolveUrl(
      "https://example.com/page",
      "//cdn.example.com/asset.js",
    );
    expect(result).toBe("https://cdn.example.com/asset.js");
  });

  it("resolves a sibling path", () => {
    const result = resolveUrl(
      "https://example.com/docs/intro",
      "./getting-started",
    );
    expect(result).toBe("https://example.com/docs/getting-started");
  });

  it("resolves query-only relative URL", () => {
    const result = resolveUrl("https://example.com/search", "?q=hello");
    expect(result).toBe("https://example.com/search?q=hello");
  });
});

// ---------------------------------------------------------------------------
// matchesPattern
// ---------------------------------------------------------------------------

describe("matchesPattern", () => {
  it("matches with wildcard at the end", () => {
    expect(
      matchesPattern("https://example.com/blog/post-1", "https://example.com/blog/*"),
    ).toBe(true);
  });

  it("matches with wildcard at the beginning", () => {
    expect(matchesPattern("https://cdn.example.com/file.pdf", "*.pdf")).toBe(
      true,
    );
  });

  it("matches with wildcard in the middle", () => {
    expect(
      matchesPattern(
        "https://example.com/blog/123/comments",
        "https://example.com/blog/*/comments",
      ),
    ).toBe(true);
  });

  it("matches exact URL (no wildcard)", () => {
    expect(
      matchesPattern("https://example.com/about", "https://example.com/about"),
    ).toBe(true);
  });

  it("returns false when pattern does not match", () => {
    expect(
      matchesPattern("https://example.com/about", "https://example.com/blog/*"),
    ).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(
      matchesPattern(
        "HTTPS://EXAMPLE.COM/page",
        "https://example.com/page",
      ),
    ).toBe(true);
  });

  it("escapes regex metacharacters in the pattern", () => {
    expect(
      matchesPattern(
        "https://example.com/path?q=1&r=2",
        "https://example.com/path?q=1&r=2",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isDomainAllowed
// ---------------------------------------------------------------------------

describe("isDomainAllowed", () => {
  it("allows exact domain match", () => {
    expect(
      isDomainAllowed("https://example.com/page", ["example.com"]),
    ).toBe(true);
  });

  it("allows subdomain match", () => {
    expect(
      isDomainAllowed("https://docs.example.com/page", ["example.com"]),
    ).toBe(true);
  });

  it("allows deeply nested subdomain match", () => {
    expect(
      isDomainAllowed("https://a.b.c.example.com/page", ["example.com"]),
    ).toBe(true);
  });

  it("rejects domains that are not in the allowed list", () => {
    expect(
      isDomainAllowed("https://evil.com/page", ["example.com"]),
    ).toBe(false);
  });

  it("rejects domains that only share a suffix (not subdomain boundary)", () => {
    expect(
      isDomainAllowed("https://notexample.com/page", ["example.com"]),
    ).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(
      isDomainAllowed("https://DOCS.EXAMPLE.COM/page", ["Example.Com"]),
    ).toBe(true);
  });

  it("checks against multiple allowed domains", () => {
    expect(
      isDomainAllowed("https://other.com/page", [
        "example.com",
        "other.com",
      ]),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isFetchableUrl
// ---------------------------------------------------------------------------

describe("isFetchableUrl", () => {
  it("returns true for https URLs", () => {
    expect(isFetchableUrl("https://example.com/page")).toBe(true);
  });

  it("returns true for http URLs", () => {
    expect(isFetchableUrl("http://example.com/page")).toBe(true);
  });

  it("returns false for javascript: URLs", () => {
    expect(isFetchableUrl("javascript:alert(1)")).toBe(false);
  });

  it("returns false for mailto: URLs", () => {
    expect(isFetchableUrl("mailto:user@example.com")).toBe(false);
  });

  it("returns false for data: URLs", () => {
    expect(isFetchableUrl("data:text/html,<h1>Hi</h1>")).toBe(false);
  });

  it("returns false for ftp: URLs", () => {
    expect(isFetchableUrl("ftp://files.example.com/readme.txt")).toBe(false);
  });

  it("returns false for invalid URLs", () => {
    expect(isFetchableUrl("not-a-valid-url")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isFetchableUrl("")).toBe(false);
  });
});
