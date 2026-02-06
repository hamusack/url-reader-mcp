/**
 * @fileoverview Tests for link extraction and filtering.
 *
 * Covers: extractLinks for finding, resolving, deduplicating, and skipping links.
 * Also covers: filterLinks for domain, pattern, and internal/external filtering.
 *
 * The extractLinks function calls resolveUrl(baseUrl, trimmedHref) which
 * internally does new URL(trimmedHref, baseUrl). This means:
 *   - Relative hrefs (e.g., "/about") are resolved against baseUrl correctly.
 *   - Absolute hrefs (e.g., "https://other.com") ignore the base and resolve
 *     to themselves (per the WHATWG URL spec).
 */

import { describe, it, expect } from "bun:test";
import {
  extractLinks,
  filterLinks,
  type ResolvedLink,
} from "../../src/crawler/link-resolver.js";

// ---------------------------------------------------------------------------
// extractLinks — basic extraction
// ---------------------------------------------------------------------------

describe("extractLinks — basic link discovery", () => {
  it("resolves relative href values against the base URL", () => {
    const html = `
      <html><body>
        <a href="/about">About Us</a>
        <a href="/contact">Contact</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com");

    expect(links.length).toBe(2);
    expect(links[0].url).toBe("https://example.com/about");
    expect(links[0].text).toBe("About Us");
    expect(links[0].isInternal).toBe(true);
    expect(links[1].url).toBe("https://example.com/contact");
    expect(links[1].text).toBe("Contact");
    expect(links[1].isInternal).toBe(true);
  });

  it("resolves relative paths like ../blog against the base URL", () => {
    const html = `
      <html><body>
        <a href="../blog">Blog</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com/docs/intro");

    expect(links.length).toBe(1);
    expect(links[0].url).toBe("https://example.com/blog");
    expect(links[0].isInternal).toBe(true);
  });

  it("resolves absolute same-domain href correctly", () => {
    const html = `
      <html><body>
        <a href="https://example.com/internal-page">Internal</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com");

    expect(links.length).toBe(1);
    expect(links[0].url).toBe("https://example.com/internal-page");
    expect(links[0].isInternal).toBe(true);
  });

  it("resolves external absolute href and marks as isInternal: false", () => {
    const html = `
      <html><body>
        <a href="https://other.com/page">External</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com");

    expect(links.length).toBe(1);
    expect(links[0].url).toBe("https://other.com/page");
    expect(links[0].isInternal).toBe(false);
  });

  it("resolves absolute same-domain href to the correct normalized URL", () => {
    const html = `
      <html><body>
        <a href="https://example.com/absolute">Absolute</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com");

    expect(links.length).toBe(1);
    expect(links[0].url).toBe("https://example.com/absolute");
  });
});

// ---------------------------------------------------------------------------
// extractLinks — non-fetchable schemes
// ---------------------------------------------------------------------------

describe("extractLinks — skipping non-fetchable links", () => {
  it("skips javascript: links", () => {
    const html = `
      <html><body>
        <a href="javascript:void(0)">Click Me</a>
        <a href="https://example.com/real-page">Real Page</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com");

    expect(links.length).toBe(1);
    expect(links[0].url).toBe("https://example.com/real-page");
  });

  it("skips mailto: links", () => {
    const html = `
      <html><body>
        <a href="mailto:user@example.com">Email</a>
        <a href="https://example.com/page">Page</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com");

    expect(links.length).toBe(1);
    expect(links[0].text).toBe("Page");
  });

  it("skips tel: links", () => {
    const html = `
      <html><body>
        <a href="tel:+1234567890">Call</a>
        <a href="https://example.com/page">Page</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com");

    expect(links.length).toBe(1);
  });

  it("skips fragment-only links", () => {
    const html = `
      <html><body>
        <a href="#section">Jump</a>
        <a href="https://example.com/page">Page</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com");

    expect(links.length).toBe(1);
    expect(links[0].text).toBe("Page");
  });

  it("skips anchor elements without href", () => {
    const html = `
      <html><body>
        <a name="anchor">Named Anchor</a>
        <a href="https://example.com/page">Page</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com");

    expect(links.length).toBe(1);
    expect(links[0].text).toBe("Page");
  });
});

// ---------------------------------------------------------------------------
// extractLinks — deduplication
// ---------------------------------------------------------------------------

describe("extractLinks — deduplication", () => {
  it("deduplicates links that resolve to the same normalized URL", () => {
    const html = `
      <html><body>
        <a href="https://example.com/page">First</a>
        <a href="https://example.com/other">Second</a>
        <a href="https://example.com/page#fragment">Third (with fragment)</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com");

    // /page and /page#fragment normalize to the same URL, so dedup to 2
    expect(links.length).toBe(2);
    expect(links[0].text).toBe("First"); // first occurrence wins
    expect(links[0].url).toBe("https://example.com/page");
    expect(links[1].text).toBe("Second");
    expect(links[1].url).toBe("https://example.com/other");
  });

  it("keeps distinct absolute hrefs as separate links", () => {
    const html = `
      <html><body>
        <a href="https://example.com/page-1">Page 1</a>
        <a href="https://example.com/page-2">Page 2</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com");

    expect(links.length).toBe(2);
    expect(links[0].url).toBe("https://example.com/page-1");
    expect(links[1].url).toBe("https://example.com/page-2");
  });

  it("deduplicates case-insensitive host differences", () => {
    const html = `
      <html><body>
        <a href="https://example.com/page">Lower</a>
        <a href="https://EXAMPLE.COM/page">Upper</a>
      </body></html>
    `;
    const links = extractLinks(html, "https://example.com");

    // Both normalize to https://example.com/page
    expect(links.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// filterLinks — domain filtering
// ---------------------------------------------------------------------------

describe("filterLinks — domain filtering", () => {
  const sampleLinks: ResolvedLink[] = [
    { text: "Home", url: "https://example.com", isInternal: true },
    { text: "Blog", url: "https://example.com/blog", isInternal: true },
    { text: "Docs", url: "https://docs.example.com/guide", isInternal: false },
    { text: "Other", url: "https://other.com", isInternal: false },
  ];

  it("filters links to only allowed domains", () => {
    const result = filterLinks(sampleLinks, "example.com", {
      allowedDomains: ["example.com"],
    });

    expect(result.length).toBe(2);
    expect(result.every((l) => l.url.includes("example.com"))).toBe(true);
    expect(result.some((l) => l.url.includes("docs.example.com"))).toBe(false);
  });

  it("allows multiple domains", () => {
    const result = filterLinks(sampleLinks, "example.com", {
      allowedDomains: ["example.com", "other.com"],
    });

    expect(result.length).toBe(3); // example.com x2 + other.com
  });

  it("returns all links when no domain filter is set", () => {
    const result = filterLinks(sampleLinks, "example.com", {});

    expect(result.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// filterLinks — exclude patterns
// ---------------------------------------------------------------------------

describe("filterLinks — exclude patterns", () => {
  const sampleLinks: ResolvedLink[] = [
    { text: "Home", url: "https://example.com", isInternal: true },
    { text: "Blog", url: "https://example.com/blog", isInternal: true },
    { text: "Admin", url: "https://example.com/admin/panel", isInternal: true },
    { text: "Login", url: "https://example.com/login", isInternal: true },
  ];

  it("excludes links matching exclude patterns", () => {
    const result = filterLinks(sampleLinks, "example.com", {
      excludePatterns: ["*/admin/*"],
    });

    expect(result.length).toBe(3);
    expect(result.some((l) => l.text === "Admin")).toBe(false);
  });

  it("supports multiple exclude patterns", () => {
    const result = filterLinks(sampleLinks, "example.com", {
      excludePatterns: ["*/admin/*", "*/login"],
    });

    expect(result.length).toBe(2);
    expect(result.some((l) => l.text === "Admin")).toBe(false);
    expect(result.some((l) => l.text === "Login")).toBe(false);
  });

  it("returns all links when exclude patterns list is empty", () => {
    const result = filterLinks(sampleLinks, "example.com", {
      excludePatterns: [],
    });

    expect(result.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// filterLinks — include patterns
// ---------------------------------------------------------------------------

describe("filterLinks — include patterns", () => {
  const sampleLinks: ResolvedLink[] = [
    { text: "Home", url: "https://example.com", isInternal: true },
    { text: "Blog", url: "https://example.com/blog/post-1", isInternal: true },
    { text: "Docs", url: "https://example.com/docs/guide", isInternal: true },
    { text: "About", url: "https://example.com/about", isInternal: true },
  ];

  it("keeps only links matching include patterns", () => {
    const result = filterLinks(sampleLinks, "example.com", {
      includePatterns: ["*/blog/*"],
    });

    expect(result.length).toBe(1);
    expect(result[0].text).toBe("Blog");
  });

  it("supports multiple include patterns (OR logic)", () => {
    const result = filterLinks(sampleLinks, "example.com", {
      includePatterns: ["*/blog/*", "*/docs/*"],
    });

    expect(result.length).toBe(2);
    expect(result.some((l) => l.text === "Blog")).toBe(true);
    expect(result.some((l) => l.text === "Docs")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// filterLinks — internal/external filter
// ---------------------------------------------------------------------------

describe("filterLinks — internal/external filter", () => {
  const sampleLinks: ResolvedLink[] = [
    { text: "Internal 1", url: "https://example.com/page1", isInternal: true },
    { text: "Internal 2", url: "https://example.com/page2", isInternal: true },
    { text: "External 1", url: "https://other.com/page", isInternal: false },
    { text: "External 2", url: "https://another.com/page", isInternal: false },
  ];

  it("keeps only internal links when filter is 'internal'", () => {
    const result = filterLinks(sampleLinks, "example.com", {
      filter: "internal",
    });

    expect(result.length).toBe(2);
    expect(result.every((l) => l.isInternal)).toBe(true);
  });

  it("keeps only external links when filter is 'external'", () => {
    const result = filterLinks(sampleLinks, "example.com", {
      filter: "external",
    });

    expect(result.length).toBe(2);
    expect(result.every((l) => !l.isInternal)).toBe(true);
  });

  it("keeps all links when filter is 'all'", () => {
    const result = filterLinks(sampleLinks, "example.com", {
      filter: "all",
    });

    expect(result.length).toBe(4);
  });

  it("keeps all links when filter is not specified", () => {
    const result = filterLinks(sampleLinks, "example.com", {});

    expect(result.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// filterLinks — combined filters
// ---------------------------------------------------------------------------

describe("filterLinks — combined filters", () => {
  const sampleLinks: ResolvedLink[] = [
    { text: "Blog Post", url: "https://example.com/blog/post-1", isInternal: true },
    { text: "Blog Admin", url: "https://example.com/blog/admin/edit", isInternal: true },
    { text: "Home", url: "https://example.com", isInternal: true },
    { text: "External Blog", url: "https://other.com/blog/post", isInternal: false },
  ];

  it("applies internal filter + include pattern + exclude pattern", () => {
    const result = filterLinks(sampleLinks, "example.com", {
      filter: "internal",
      includePatterns: ["*/blog/*"],
      excludePatterns: ["*/admin/*"],
    });

    // Only "Blog Post" matches: internal + matches /blog/* + not /admin/*
    expect(result.length).toBe(1);
    expect(result[0].text).toBe("Blog Post");
  });
});
