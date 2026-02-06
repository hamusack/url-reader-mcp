/**
 * @fileoverview Tests for SSRF protection utilities.
 *
 * Covers: isPrivateIP for IPv4, IPv6, and edge cases.
 */

import { describe, it, expect } from "bun:test";
import { isPrivateIP } from "../../src/utils/network.js";

// ---------------------------------------------------------------------------
// isPrivateIP — IPv4 private addresses
// ---------------------------------------------------------------------------

describe("isPrivateIP — private IPv4 addresses", () => {
  it("detects 127.0.0.1 (loopback) as private", () => {
    expect(isPrivateIP("127.0.0.1")).toBe(true);
  });

  it("detects 127.0.0.2 (loopback range) as private", () => {
    expect(isPrivateIP("127.0.0.2")).toBe(true);
  });

  it("detects 127.255.255.255 (loopback range end) as private", () => {
    expect(isPrivateIP("127.255.255.255")).toBe(true);
  });

  it("detects 10.0.0.1 (Class A private) as private", () => {
    expect(isPrivateIP("10.0.0.1")).toBe(true);
  });

  it("detects 10.255.255.255 (Class A private range end) as private", () => {
    expect(isPrivateIP("10.255.255.255")).toBe(true);
  });

  it("detects 172.16.0.1 (Class B private start) as private", () => {
    expect(isPrivateIP("172.16.0.1")).toBe(true);
  });

  it("detects 172.31.255.255 (Class B private end) as private", () => {
    expect(isPrivateIP("172.31.255.255")).toBe(true);
  });

  it("detects 192.168.0.1 (Class C private) as private", () => {
    expect(isPrivateIP("192.168.0.1")).toBe(true);
  });

  it("detects 192.168.255.255 (Class C private end) as private", () => {
    expect(isPrivateIP("192.168.255.255")).toBe(true);
  });

  it("detects 169.254.169.254 (AWS IMDS / link-local) as private", () => {
    expect(isPrivateIP("169.254.169.254")).toBe(true);
  });

  it("detects 169.254.0.1 (link-local range) as private", () => {
    expect(isPrivateIP("169.254.0.1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIP — IPv4 public addresses
// ---------------------------------------------------------------------------

describe("isPrivateIP — public IPv4 addresses", () => {
  it("returns false for 8.8.8.8 (Google DNS)", () => {
    expect(isPrivateIP("8.8.8.8")).toBe(false);
  });

  it("returns false for 1.1.1.1 (Cloudflare DNS)", () => {
    expect(isPrivateIP("1.1.1.1")).toBe(false);
  });

  it("returns false for 93.184.216.34 (example.com)", () => {
    expect(isPrivateIP("93.184.216.34")).toBe(false);
  });

  it("returns false for 172.32.0.1 (just outside Class B private range)", () => {
    expect(isPrivateIP("172.32.0.1")).toBe(false);
  });

  it("returns false for 11.0.0.1 (just outside Class A private range)", () => {
    expect(isPrivateIP("11.0.0.1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIP — IPv4 edge cases
// ---------------------------------------------------------------------------

describe("isPrivateIP — IPv4 edge cases", () => {
  it("detects 0.0.0.0 (this-network) as private", () => {
    expect(isPrivateIP("0.0.0.0")).toBe(true);
  });

  it("detects 0.255.255.255 (this-network range end) as private", () => {
    expect(isPrivateIP("0.255.255.255")).toBe(true);
  });

  it("detects 100.64.0.1 (CGNAT) as private", () => {
    expect(isPrivateIP("100.64.0.1")).toBe(true);
  });

  it("detects 100.127.255.255 (CGNAT range end) as private", () => {
    expect(isPrivateIP("100.127.255.255")).toBe(true);
  });

  it("returns false for 100.128.0.0 (just outside CGNAT range)", () => {
    expect(isPrivateIP("100.128.0.0")).toBe(false);
  });

  it("detects 192.0.0.1 (IETF protocol assignments) as private", () => {
    expect(isPrivateIP("192.0.0.1")).toBe(true);
  });

  it("detects 198.18.0.1 (benchmarking range) as private", () => {
    expect(isPrivateIP("198.18.0.1")).toBe(true);
  });

  it("detects 198.19.255.255 (benchmarking range end) as private", () => {
    expect(isPrivateIP("198.19.255.255")).toBe(true);
  });

  it("returns false for 198.20.0.0 (just outside benchmarking range)", () => {
    expect(isPrivateIP("198.20.0.0")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isPrivateIP — IPv6
// ---------------------------------------------------------------------------

describe("isPrivateIP — IPv6 addresses", () => {
  it("detects ::1 (IPv6 loopback) as private", () => {
    expect(isPrivateIP("::1")).toBe(true);
  });

  it("detects :: (IPv6 unspecified) as private", () => {
    expect(isPrivateIP("::")).toBe(true);
  });

  it("detects fc00::1 (Unique Local Address) as private", () => {
    expect(isPrivateIP("fc00::1")).toBe(true);
  });

  it("detects fd00::1 (Unique Local Address) as private", () => {
    expect(isPrivateIP("fd00::1")).toBe(true);
  });

  it("detects fe80::1 (Link-Local) as private", () => {
    expect(isPrivateIP("fe80::1")).toBe(true);
  });

  it("detects febf::1 (Link-Local range end) as private", () => {
    expect(isPrivateIP("febf::1")).toBe(true);
  });

  it("returns false for a public IPv6 address (2607:f8b0:4004:800::200e)", () => {
    expect(isPrivateIP("2607:f8b0:4004:800::200e")).toBe(false);
  });

  it("returns false for 2001:db8::1 (documentation prefix, not private)", () => {
    // 2001:db8::/32 is reserved for documentation, but is not classified
    // as private in the implementation's checked ranges.
    expect(isPrivateIP("2001:db8::1")).toBe(false);
  });
});
