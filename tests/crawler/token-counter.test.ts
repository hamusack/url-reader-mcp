/**
 * @fileoverview Tests for the estimation utility that calculates
 * approximate LLM usage counts from text content.
 *
 * Covers: estimateTokens for empty strings, English text, Japanese text,
 * mixed content, and single characters.
 */

import { describe, it, expect } from "bun:test";
import { estimateTokens } from "../../src/crawler/token-counter.js";

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("returns at least 1 for a whitespace-only string", () => {
    // Whitespace-only strings are non-empty; the implementation guarantees
    // Math.max(1, estimated) for any non-empty input.
    expect(estimateTokens("   ")).toBe(1);
  });

  it("estimates English text at roughly length / 4", () => {
    // Average English word piece is ~4 characters (OpenAI rule of thumb).
    const englishText =
      "The quick brown fox jumps over the lazy dog. This is a test sentence for estimation.";
    const estimate = estimateTokens(englishText);
    const approximateExpected = Math.ceil(englishText.length / 4);

    // Allow a reasonable tolerance: within 50% of the length/4 heuristic
    expect(estimate).toBeGreaterThan(approximateExpected * 0.5);
    expect(estimate).toBeLessThan(approximateExpected * 1.5);
  });

  it("estimates Japanese text at roughly length / 1.5", () => {
    // Japanese characters typically produce more pieces per character.
    const japaneseText =
      "日本語のテスト文章です。推定数をテストしています。これは比較的長い文章で、推定精度を確認するためのものです。";
    const estimate = estimateTokens(japaneseText);
    const approximateExpected = Math.ceil(japaneseText.length / 1.5);

    // Allow a reasonable tolerance: within 50% of the length/1.5 heuristic
    expect(estimate).toBeGreaterThan(approximateExpected * 0.5);
    expect(estimate).toBeLessThan(approximateExpected * 1.5);
  });

  it("estimates mixed English and Japanese text between the two extremes", () => {
    const mixedText =
      "Hello world! これはテストです。Mixed content with both English and 日本語 text.";
    const estimate = estimateTokens(mixedText);

    // The estimate should be between pure-English and pure-Japanese heuristics
    const englishEstimate = Math.ceil(mixedText.length / 4);
    const japaneseEstimate = Math.ceil(mixedText.length / 1.5);

    expect(estimate).toBeGreaterThanOrEqual(englishEstimate * 0.5);
    expect(estimate).toBeLessThanOrEqual(japaneseEstimate * 1.5);
  });

  it("returns at least 1 for a single character", () => {
    expect(estimateTokens("a")).toBeGreaterThanOrEqual(1);
  });

  it("returns at least 1 for a single Japanese character", () => {
    expect(estimateTokens("日")).toBeGreaterThanOrEqual(1);
  });

  it("produces a positive integer for realistic content", () => {
    const content = "This is a realistic blog post content that might be extracted from a web page. It contains multiple sentences and paragraphs to simulate real-world usage of the counter.";
    const estimate = estimateTokens(content);

    expect(estimate).toBeGreaterThan(0);
    expect(Number.isInteger(estimate)).toBe(true);
  });
});
