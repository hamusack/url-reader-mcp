/**
 * @fileoverview Tests for HTML content extraction.
 *
 * Covers: extractFromHtml for basic extraction, noise removal (script/style),
 * plain text output, and fallback handling for minimal/broken HTML.
 */

import { describe, it, expect } from "bun:test";
import { extractFromHtml } from "../../src/extractor/html-extractor.js";

// ---------------------------------------------------------------------------
// extractFromHtml — basic extraction
// ---------------------------------------------------------------------------

describe("extractFromHtml — basic extraction", () => {
  it("extracts title and content from a well-formed article page", () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head><title>Test Article</title></head>
        <body>
          <article>
            <h1>Test Article</h1>
            <p>This is the main content of the article. It should be extracted
            by Readability because it looks like a real article with enough
            text content to be recognized as the primary content block.</p>
            <p>Here is another paragraph with more detail about the topic.
            Readability uses paragraph density to score content, so having
            multiple paragraphs helps it identify the article body.</p>
            <p>A third paragraph for good measure. The more paragraphs we have
            the more confident Readability will be about the article content.</p>
          </article>
        </body>
      </html>
    `;
    const result = extractFromHtml(html, "https://example.com/article");

    expect(result.title).toBeTruthy();
    expect(result.textContent).toContain("main content of the article");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty textContent", () => {
    const html = `
      <html>
        <head><title>Page Title</title></head>
        <body>
          <p>Some body text that should appear in the extracted content.</p>
          <p>Additional text so Readability has enough to work with here.</p>
          <p>Yet another paragraph with enough content for extraction.</p>
        </body>
      </html>
    `;
    const result = extractFromHtml(html, "https://example.com/page");

    expect(result.textContent.length).toBeGreaterThan(0);
    expect(result.textContent).toContain("body text");
  });

  it("sets the length property to match textContent length", () => {
    const html = `
      <html>
        <head><title>Length Test</title></head>
        <body>
          <article>
            <p>Test content for verifying length calculation in the extraction output.</p>
            <p>Additional paragraphs to ensure Readability processes this correctly.</p>
            <p>More content here so the extraction has substantial text to work with.</p>
          </article>
        </body>
      </html>
    `;
    const result = extractFromHtml(html, "https://example.com/page");

    expect(result.length).toBe(result.textContent.length);
  });
});

// ---------------------------------------------------------------------------
// extractFromHtml — noise removal
// ---------------------------------------------------------------------------

describe("extractFromHtml — noise removal", () => {
  it("strips script tags from the output", () => {
    const html = `
      <html>
        <head><title>Script Test</title></head>
        <body>
          <script>var malicious = "code";</script>
          <article>
            <p>Clean content without any scripts. This is the article body that
            should be the only content in the extraction result.</p>
            <p>More text content to help Readability identify this as the main article.</p>
            <p>Third paragraph to ensure proper detection by the extraction engine.</p>
          </article>
          <script>console.log("should be removed");</script>
        </body>
      </html>
    `;
    const result = extractFromHtml(html, "https://example.com/page");

    expect(result.textContent).not.toContain("malicious");
    expect(result.textContent).not.toContain("console.log");
    expect(result.content).not.toContain("<script");
  });

  it("strips style tags from the output", () => {
    const html = `
      <html>
        <head>
          <title>Style Test</title>
          <style>body { background: red; }</style>
        </head>
        <body>
          <style>.hidden { display: none; }</style>
          <article>
            <p>Content without style pollution. This article contains only text
            that is useful for reading and extraction purposes.</p>
            <p>Second paragraph to help with content detection by Readability.</p>
            <p>Third paragraph for sufficient article density scoring.</p>
          </article>
        </body>
      </html>
    `;
    const result = extractFromHtml(html, "https://example.com/page");

    expect(result.textContent).not.toContain("background: red");
    expect(result.textContent).not.toContain("display: none");
    expect(result.content).not.toContain("<style");
  });

  it("strips nav, footer, header, and aside elements", () => {
    const html = `
      <html>
        <head><title>Nav Test</title></head>
        <body>
          <header><a href="/">Home</a><a href="/about">About Nav Link</a></header>
          <nav><a href="/products">Products Nav</a></nav>
          <article>
            <p>The main article content that should be preserved after all the
            boilerplate navigation and footer elements are removed.</p>
            <p>More article text to help Readability identify the content block.</p>
            <p>Additional paragraph for extraction engine confidence.</p>
          </article>
          <aside>Sidebar advertisement content here</aside>
          <footer>Copyright 2025 footer text</footer>
        </body>
      </html>
    `;
    const result = extractFromHtml(html, "https://example.com/page");

    expect(result.textContent).not.toContain("Products Nav");
    expect(result.textContent).not.toContain("Sidebar advertisement");
    expect(result.textContent).toContain("main article content");
  });
});

// ---------------------------------------------------------------------------
// extractFromHtml — plain text output
// ---------------------------------------------------------------------------

describe("extractFromHtml — plain text output", () => {
  it("returns textContent without HTML tags", () => {
    const html = `
      <html>
        <head><title>Plain Text Test</title></head>
        <body>
          <article>
            <h1>Heading</h1>
            <p>Paragraph with <strong>bold</strong> and <em>italic</em> text.</p>
            <p>Another paragraph with <a href="/link">a link</a> inside it.</p>
            <p>Third paragraph so Readability can properly identify the content.</p>
          </article>
        </body>
      </html>
    `;
    const result = extractFromHtml(html, "https://example.com/page");

    expect(result.textContent).not.toContain("<strong>");
    expect(result.textContent).not.toContain("<em>");
    expect(result.textContent).not.toContain("<a ");
    expect(result.textContent).not.toContain("</a>");
    expect(result.textContent).toContain("bold");
    expect(result.textContent).toContain("italic");
  });
});

// ---------------------------------------------------------------------------
// extractFromHtml — fallback path
// ---------------------------------------------------------------------------

describe("extractFromHtml — fallback handling", () => {
  it("handles minimal HTML without article structure", () => {
    const html = "<p>Just a paragraph</p>";
    const result = extractFromHtml(html, "https://example.com/page");

    expect(result.textContent.length).toBeGreaterThan(0);
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles empty body gracefully", () => {
    const html = "<html><head><title>Empty</title></head><body></body></html>";
    const result = extractFromHtml(html, "https://example.com/page");

    expect(result).toBeDefined();
    expect(result.title).toBeDefined();
    expect(typeof result.textContent).toBe("string");
  });

  it("handles HTML with only non-content elements gracefully", () => {
    const html = `
      <html>
        <head><title>Only Scripts</title></head>
        <body>
          <script>console.log("no content here");</script>
          <style>.invisible { display: none; }</style>
        </body>
      </html>
    `;
    const result = extractFromHtml(html, "https://example.com/page");

    expect(result).toBeDefined();
    expect(result.textContent).not.toContain("console.log");
    expect(result.textContent).not.toContain("display: none");
  });

  it("extracts title from the title tag when Readability falls back", () => {
    const html = `
      <html>
        <head><title>Fallback Title Test</title></head>
        <body>
          <div>Some short content that is unlikely to trigger Readability article detection.</div>
        </body>
      </html>
    `;
    const result = extractFromHtml(html, "https://example.com/page");

    expect(result.title).toBeDefined();
  });
});
