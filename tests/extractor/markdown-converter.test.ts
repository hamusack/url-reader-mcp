/**
 * @fileoverview Tests for HTML-to-Markdown conversion and post-processing.
 *
 * Covers: htmlToMarkdown for headings, bold/italic, links, truncation.
 * Also covers: postProcessMarkdown for newline normalization and whitespace trimming.
 */

import { describe, it, expect } from "bun:test";
import {
  htmlToMarkdown,
  postProcessMarkdown,
} from "../../src/extractor/markdown-converter.js";

// ---------------------------------------------------------------------------
// htmlToMarkdown — headings
// ---------------------------------------------------------------------------

describe("htmlToMarkdown — headings", () => {
  it("converts h1 to # syntax", () => {
    const result = htmlToMarkdown("<h1>Main Heading</h1>");
    expect(result).toContain("# Main Heading");
  });

  it("converts h2 to ## syntax", () => {
    const result = htmlToMarkdown("<h2>Sub Heading</h2>");
    expect(result).toContain("## Sub Heading");
  });

  it("converts h3 to ### syntax", () => {
    const result = htmlToMarkdown("<h3>Third Level</h3>");
    expect(result).toContain("### Third Level");
  });

  it("converts multiple heading levels", () => {
    const result = htmlToMarkdown(
      "<h1>Title</h1><h2>Section</h2><h3>Subsection</h3>",
    );
    expect(result).toContain("# Title");
    expect(result).toContain("## Section");
    expect(result).toContain("### Subsection");
  });
});

// ---------------------------------------------------------------------------
// htmlToMarkdown — inline formatting
// ---------------------------------------------------------------------------

describe("htmlToMarkdown — bold and italic", () => {
  it("converts <strong> to ** syntax", () => {
    const result = htmlToMarkdown("<p>This is <strong>bold</strong> text</p>");
    expect(result).toContain("**bold**");
  });

  it("converts <b> to ** syntax", () => {
    const result = htmlToMarkdown("<p>This is <b>bold</b> text</p>");
    expect(result).toContain("**bold**");
  });

  it("converts <em> to _ syntax", () => {
    const result = htmlToMarkdown("<p>This is <em>italic</em> text</p>");
    expect(result).toContain("_italic_");
  });

  it("converts <i> to _ syntax", () => {
    const result = htmlToMarkdown("<p>This is <i>italic</i> text</p>");
    expect(result).toContain("_italic_");
  });
});

// ---------------------------------------------------------------------------
// htmlToMarkdown — links
// ---------------------------------------------------------------------------

describe("htmlToMarkdown — links", () => {
  it("preserves links when includeLinks is true (default)", () => {
    const result = htmlToMarkdown(
      '<p>Visit <a href="https://example.com">Example</a></p>',
    );
    expect(result).toContain("[Example](https://example.com)");
  });

  it("preserves links when includeLinks is explicitly true", () => {
    const result = htmlToMarkdown(
      '<p>Visit <a href="https://example.com">Example</a></p>',
      { includeLinks: true },
    );
    expect(result).toContain("[Example](https://example.com)");
  });

  it("strips links when includeLinks is false, keeping text", () => {
    const result = htmlToMarkdown(
      '<p>Visit <a href="https://example.com">Example</a> now</p>',
      { includeLinks: false },
    );
    expect(result).toContain("Example");
    expect(result).not.toContain("https://example.com");
    expect(result).not.toContain("[");
    expect(result).not.toContain("](");
  });
});

// ---------------------------------------------------------------------------
// htmlToMarkdown — truncation
// ---------------------------------------------------------------------------

describe("htmlToMarkdown — truncation", () => {
  it("truncates output to maxLength", () => {
    const longHtml =
      "<p>" + "This is a long sentence for testing truncation. ".repeat(20) + "</p>";
    const result = htmlToMarkdown(longHtml, { maxLength: 100 });

    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("appends ellipsis when truncated", () => {
    const longHtml =
      "<p>" + "Word ".repeat(100) + "</p>";
    const result = htmlToMarkdown(longHtml, { maxLength: 50 });

    expect(result).toContain("...");
  });

  it("does not truncate when content is shorter than maxLength", () => {
    const shortHtml = "<p>Short text</p>";
    const result = htmlToMarkdown(shortHtml, { maxLength: 1000 });

    expect(result).not.toContain("...");
    expect(result).toContain("Short text");
  });
});

// ---------------------------------------------------------------------------
// htmlToMarkdown — edge cases
// ---------------------------------------------------------------------------

describe("htmlToMarkdown — edge cases", () => {
  it("returns empty string for empty input", () => {
    expect(htmlToMarkdown("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(htmlToMarkdown("   ")).toBe("");
  });

  it("converts strikethrough tags to ~~ syntax", () => {
    const result = htmlToMarkdown("<p>This is <del>wrong</del> right</p>");
    expect(result).toContain("~~wrong~~");
  });
});

// ---------------------------------------------------------------------------
// postProcessMarkdown — newline normalization
// ---------------------------------------------------------------------------

describe("postProcessMarkdown — newline normalization", () => {
  it("collapses 3+ consecutive newlines to exactly 2", () => {
    const input = "Line one\n\n\n\nLine two";
    const result = postProcessMarkdown(input);
    expect(result).toBe("Line one\n\nLine two");
  });

  it("collapses 5+ consecutive newlines to exactly 2", () => {
    const input = "First\n\n\n\n\nSecond";
    const result = postProcessMarkdown(input);
    expect(result).toBe("First\n\nSecond");
  });

  it("preserves exactly 2 consecutive newlines (one blank line)", () => {
    const input = "Paragraph one\n\nParagraph two";
    const result = postProcessMarkdown(input);
    expect(result).toBe("Paragraph one\n\nParagraph two");
  });

  it("preserves single newlines", () => {
    const input = "Line one\nLine two";
    const result = postProcessMarkdown(input);
    expect(result).toBe("Line one\nLine two");
  });
});

// ---------------------------------------------------------------------------
// postProcessMarkdown — whitespace cleanup
// ---------------------------------------------------------------------------

describe("postProcessMarkdown — whitespace cleanup", () => {
  it("removes trailing whitespace from lines", () => {
    const input = "Line one   \nLine two\t\t\nLine three";
    const result = postProcessMarkdown(input);
    expect(result).toBe("Line one\nLine two\nLine three");
  });

  it("trims leading and trailing whitespace from the entire string", () => {
    const input = "  \n\nContent here\n\n  ";
    const result = postProcessMarkdown(input);
    expect(result).toBe("Content here");
  });

  it("removes zero-width characters", () => {
    const input = "Hello\u200BWorld\u200CTest\uFEFF";
    const result = postProcessMarkdown(input);
    expect(result).toBe("HelloWorldTest");
  });

  it("handles empty string input", () => {
    const result = postProcessMarkdown("");
    expect(result).toBe("");
  });
});
