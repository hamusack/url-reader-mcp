/**
 * @module utils/network
 * @fileoverview Network security utilities for SSRF (Server-Side Request Forgery) prevention.
 *
 * When an MCP server fetches URLs on behalf of an LLM, it becomes a potential
 * SSRF vector: a malicious prompt could instruct the LLM to request internal
 * resources (e.g., cloud metadata endpoints, internal APIs, admin panels).
 * This module provides the defense layer that blocks such requests before
 * any network traffic leaves the host.
 *
 * ## Threat Model
 * An attacker controls the URL (directly or via prompt injection) and wants to:
 * 1. **Read internal services:** `http://169.254.169.254/latest/meta-data/` (AWS IMDS)
 * 2. **Scan internal network:** `http://192.168.1.1/admin`
 * 3. **Access loopback services:** `http://127.0.0.1:8080/internal-api`
 * 4. **Exploit IPv6 loopback:** `http://[::1]:8080/`
 *
 * ## Defense Strategy
 * 1. Parse the URL and extract the hostname.
 * 2. Resolve the hostname to IP addresses via DNS.
 * 3. Check every resolved IP against known private/reserved ranges.
 * 4. Block the request if ANY resolved IP is private.
 *
 * WHY check ALL resolved IPs: A hostname can have multiple A/AAAA records.
 * An attacker could configure DNS to return both a public IP and a private IP.
 * Checking all resolved addresses closes this "dual-stack" attack vector.
 *
 * ## Blocked IP Ranges
 * | Range               | Purpose                    | RFC      |
 * |---------------------|----------------------------|----------|
 * | `127.0.0.0/8`       | Loopback                   | RFC 1122 |
 * | `10.0.0.0/8`        | Private (Class A)          | RFC 1918 |
 * | `172.16.0.0/12`     | Private (Class B)          | RFC 1918 |
 * | `192.168.0.0/16`    | Private (Class C)          | RFC 1918 |
 * | `169.254.0.0/16`    | Link-Local / APIPA         | RFC 3927 |
 * | `0.0.0.0/8`         | "This" network             | RFC 1122 |
 * | `100.64.0.0/10`     | Carrier-Grade NAT (CGNAT)  | RFC 6598 |
 * | `192.0.0.0/24`      | IETF Protocol Assignments  | RFC 6890 |
 * | `198.18.0.0/15`     | Benchmarking               | RFC 2544 |
 * | `::1`               | IPv6 Loopback              | RFC 4291 |
 * | `fc00::/7`          | IPv6 Unique Local (ULA)    | RFC 4193 |
 * | `fe80::/10`         | IPv6 Link-Local            | RFC 4291 |
 * | `::`                | IPv6 Unspecified            | RFC 4291 |
 *
 * ## Extension Points
 * - Custom allow-lists (e.g., permit specific internal IPs for enterprise use).
 * - Custom block-lists (e.g., block specific public IPs).
 * - DNS rebinding protection (re-check IPs at connection time, not just at DNS time).
 * - DNS-over-HTTPS for environments where local DNS is untrusted.
 *
 * @example
 * ```ts
 * import { validateHostname, isPrivateIP } from "./utils/network.js";
 *
 * // Before fetching a URL:
 * await validateHostname("example.com");     // OK -- resolves to public IP
 * await validateHostname("localhost");        // throws SecurityError
 * await validateHostname("internal.corp");    // throws SecurityError (if resolves to 10.x.x.x)
 *
 * // Direct IP check:
 * isPrivateIP("192.168.1.1");  // true
 * isPrivateIP("8.8.8.8");      // false
 * ```
 */

import dns from "node:dns/promises";
import { SecurityError } from "./errors.js";

/* ────────────────────────────────────────────────────────────────────────────
 * IPv4 Private Range Definitions
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Represents a contiguous range of IPv4 addresses defined by numeric
 * boundaries (inclusive on both ends).
 *
 * WHY numeric boundaries instead of CIDR parsing: Converting an IP to
 * a 32-bit integer and doing `start <= ip <= end` is a single comparison
 * per range -- O(1) per check, O(n) for n ranges. CIDR prefix matching
 * requires bit-masking which is equally fast but harder to read and debug.
 * Numeric ranges also make it trivial to support non-CIDR ranges if needed.
 */
interface IPv4Range {
  /** Human-readable label for logging and error messages. */
  readonly label: string;
  /** Start of range as a 32-bit unsigned integer (inclusive). */
  readonly start: number;
  /** End of range as a 32-bit unsigned integer (inclusive). */
  readonly end: number;
}

/**
 * Convert a dotted-quad IPv4 string to a 32-bit unsigned integer.
 *
 * This is the core primitive for range checking. By converting IPs to
 * integers, we can do simple numeric comparisons instead of parsing
 * strings repeatedly.
 *
 * @param ip - IPv4 address in dotted-quad notation (e.g., "192.168.1.1").
 * @returns The IP as a 32-bit unsigned integer.
 *
 * @example
 * ```ts
 * ipv4ToInt("0.0.0.0");       // => 0
 * ipv4ToInt("127.0.0.1");     // => 2130706433
 * ipv4ToInt("255.255.255.255"); // => 4294967295
 * ```
 *
 * @internal
 */
function ipv4ToInt(ip: string): number {
  const parts = ip.split(".");

  // WHY >>> 0 (unsigned right shift by 0): JavaScript bitwise operators
  // work on signed 32-bit integers. Without this, IPs in the 128.0.0.0+
  // range would produce negative numbers because the high bit is set.
  // The unsigned right-shift by 0 reinterprets the result as unsigned,
  // giving us the correct positive 32-bit value.
  return (
    ((parseInt(parts[0], 10) << 24) |
      (parseInt(parts[1], 10) << 16) |
      (parseInt(parts[2], 10) << 8) |
      parseInt(parts[3], 10)) >>>
    0
  );
}

/**
 * All IPv4 address ranges that are considered "private" or "reserved"
 * and should be blocked from SSRF attacks.
 *
 * The ranges are ordered from most commonly encountered to least, but
 * since we check all ranges for every IP, the order doesn't affect
 * correctness -- only log readability when multiple ranges overlap
 * (they don't in this list).
 *
 * @internal
 */
const IPV4_PRIVATE_RANGES: readonly IPv4Range[] = [
  {
    label: "Loopback (127.0.0.0/8)",
    start: ipv4ToInt("127.0.0.0"),
    end: ipv4ToInt("127.255.255.255"),
  },
  {
    label: "Private Class A (10.0.0.0/8)",
    start: ipv4ToInt("10.0.0.0"),
    end: ipv4ToInt("10.255.255.255"),
  },
  {
    label: "Private Class B (172.16.0.0/12)",
    start: ipv4ToInt("172.16.0.0"),
    end: ipv4ToInt("172.31.255.255"),
  },
  {
    label: "Private Class C (192.168.0.0/16)",
    start: ipv4ToInt("192.168.0.0"),
    end: ipv4ToInt("192.168.255.255"),
  },
  {
    // WHY block link-local: 169.254.x.x is used for APIPA (automatic
    // private IP addressing) and, critically, for cloud metadata services.
    // AWS IMDS lives at 169.254.169.254 and is the #1 SSRF target.
    label: "Link-Local (169.254.0.0/16)",
    start: ipv4ToInt("169.254.0.0"),
    end: ipv4ToInt("169.254.255.255"),
  },
  {
    // WHY block 0.0.0.0/8: The "this network" range. On some OSes,
    // 0.0.0.0 binds to all interfaces, making it equivalent to loopback
    // for SSRF purposes.
    label: "This Network (0.0.0.0/8)",
    start: ipv4ToInt("0.0.0.0"),
    end: ipv4ToInt("0.255.255.255"),
  },
  {
    // WHY block CGNAT: Carrier-grade NAT addresses (100.64.0.0/10) are
    // used by ISPs and cloud providers for internal routing. They should
    // never be directly reachable from the public internet, but blocking
    // them adds defense-in-depth.
    label: "CGNAT (100.64.0.0/10)",
    start: ipv4ToInt("100.64.0.0"),
    end: ipv4ToInt("100.127.255.255"),
  },
  {
    label: "IETF Protocol Assignments (192.0.0.0/24)",
    start: ipv4ToInt("192.0.0.0"),
    end: ipv4ToInt("192.0.0.255"),
  },
  {
    // WHY block benchmarking range: 198.18.0.0/15 is reserved for
    // network benchmarking. It shouldn't appear in production DNS
    // responses, so blocking it catches potential DNS poisoning.
    label: "Benchmarking (198.18.0.0/15)",
    start: ipv4ToInt("198.18.0.0"),
    end: ipv4ToInt("198.19.255.255"),
  },
];

/* ────────────────────────────────────────────────────────────────────────────
 * IPv6 Private Detection
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Expand a potentially abbreviated IPv6 address to its full 8-group form.
 *
 * IPv6 addresses can be written in many abbreviated forms:
 * - `::1` (loopback -- 7 groups of zeros omitted)
 * - `fe80::1` (link-local -- groups in the middle omitted)
 * - `2001:db8::1` (documentation prefix)
 *
 * To reliably check prefixes, we need the fully expanded form with all
 * 8 groups of 4 hex digits each.
 *
 * @param ip - An IPv6 address string, possibly abbreviated.
 * @returns The fully expanded IPv6 address in lowercase (e.g., "0000:0000:0000:0000:0000:0000:0000:0001").
 *
 * @example
 * ```ts
 * expandIPv6("::1");
 * // => "0000:0000:0000:0000:0000:0000:0000:0001"
 *
 * expandIPv6("fe80::1");
 * // => "fe80:0000:0000:0000:0000:0000:0000:0001"
 *
 * expandIPv6("2001:0db8:85a3::8a2e:0370:7334");
 * // => "2001:0db8:85a3:0000:0000:8a2e:0370:7334"
 * ```
 *
 * @internal
 */
function expandIPv6(ip: string): string {
  // Remove zone ID if present (e.g., "fe80::1%eth0" -> "fe80::1").
  // Zone IDs are interface-specific and irrelevant for range checking.
  const withoutZone = ip.split("%")[0];

  // Split on "::" to find the abbreviated section.
  // WHY split on "::": The "::" notation replaces one or more groups
  // of consecutive all-zero values. We need to figure out how many
  // groups were omitted and insert them back.
  const halves = withoutZone.split("::");

  let groups: string[];

  if (halves.length === 2) {
    // "::" was found -- we need to expand it.
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];

    // Total groups in a full IPv6 address is 8.
    // The number of zero-groups to insert = 8 - (left.length + right.length).
    const missingGroups = 8 - (left.length + right.length);
    const middle = new Array(missingGroups).fill("0000");

    groups = [...left, ...middle, ...right];
  } else {
    // No "::" -- the address already has all 8 groups (possibly abbreviated).
    groups = withoutZone.split(":");
  }

  // Pad each group to exactly 4 hex digits and lowercase.
  // WHY padStart: Groups like "db8" need to become "0db8" for consistent
  // prefix comparison.
  return groups.map((g) => g.padStart(4, "0").toLowerCase()).join(":");
}

/**
 * Check whether an IPv6 address falls within a private/reserved range.
 *
 * Unlike IPv4 where we use numeric range comparisons, IPv6 addresses are
 * 128 bits wide -- too large for JavaScript's native number type (which
 * only has 53 bits of integer precision). Instead, we use string prefix
 * matching on the expanded address, which is correct for all the CIDR
 * blocks we need to check.
 *
 * @param expanded - A fully expanded IPv6 address (from {@link expandIPv6}).
 * @returns `true` if the address is in a private/reserved range.
 *
 * @internal
 */
function isIPv6Private(expanded: string): boolean {
  // WHY string prefix matching: For the ranges we care about, the
  // boundaries align on 4-bit (hex digit) or group (16-bit) boundaries:
  // - ::1 is exactly one address (loopback)
  // - fc00::/7 covers fc00:: through fdff::
  // - fe80::/10 covers fe80:: through febf::
  // - :: is exactly one address (unspecified)
  //
  // All of these can be accurately detected via prefix checks on the
  // expanded hex string, avoiding the need for 128-bit integer arithmetic.

  // Loopback (::1)
  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0001") {
    return true;
  }

  // Unspecified address (::)
  if (expanded === "0000:0000:0000:0000:0000:0000:0000:0000") {
    return true;
  }

  // Unique Local Address (fc00::/7) -- covers fc00:: through fdff::
  // WHY check first two hex chars: /7 means the first 7 bits are the
  // prefix. In hex, fc = 1111 1100 and fd = 1111 1101, so the first
  // 7 bits are 1111 110x. Checking if the first two hex chars are
  // "fc" or "fd" covers exactly this range.
  const firstTwoChars = expanded.substring(0, 2);
  if (firstTwoChars === "fc" || firstTwoChars === "fd") {
    return true;
  }

  // Link-Local (fe80::/10) -- covers fe80:: through febf::
  // WHY check first group and mask: /10 means the first 10 bits must match.
  // fe80 in binary is 1111 1110 1000 0000. The 10-bit prefix is 1111 1110 10.
  // In the first group (16 bits), this means the value must be between
  // 0xfe80 and 0xfebf. Checking the first 4 hex chars (one group) against
  // this range is exact.
  const firstGroup = parseInt(expanded.substring(0, 4), 16);
  if (firstGroup >= 0xfe80 && firstGroup <= 0xfebf) {
    return true;
  }

  // IPv4-mapped IPv6 addresses (::ffff:x.x.x.x)
  // These are encoded as 0000:0000:0000:0000:0000:ffff:XXXX:XXXX where
  // XXXX:XXXX is the IPv4 address in hex. We need to extract the IPv4
  // part and check it against IPv4 private ranges.
  // WHY: An attacker could use "::ffff:127.0.0.1" to bypass an IPv6-only check.
  if (expanded.startsWith("0000:0000:0000:0000:0000:ffff:")) {
    const ipv4HexPart = expanded.substring(30); // "XXXX:YYYY"
    const hexGroups = ipv4HexPart.split(":");
    if (hexGroups.length === 2) {
      // Convert hex groups back to dotted-quad IPv4.
      const highWord = parseInt(hexGroups[0], 16);
      const lowWord = parseInt(hexGroups[1], 16);
      const ipv4 = `${(highWord >> 8) & 0xff}.${highWord & 0xff}.${(lowWord >> 8) & 0xff}.${lowWord & 0xff}`;
      return isIPv4Private(ipv4);
    }
  }

  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * IPv4 Private Detection
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Check whether an IPv4 address is in any private/reserved range.
 *
 * Converts the IP to a 32-bit integer and checks against all defined
 * ranges using simple numeric comparisons.
 *
 * @param ip - An IPv4 address in dotted-quad notation.
 * @returns `true` if the IP is in a private/reserved range.
 *
 * @internal
 */
function isIPv4Private(ip: string): boolean {
  const ipInt = ipv4ToInt(ip);

  // Check against every private range. We use a linear scan because
  // the number of ranges is small (< 10) and the cost is negligible
  // compared to the DNS resolution that precedes this check.
  for (const range of IPV4_PRIVATE_RANGES) {
    if (ipInt >= range.start && ipInt <= range.end) {
      return true;
    }
  }

  return false;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Public API
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Determine whether an IP address string is in a private/reserved range.
 *
 * Handles both IPv4 and IPv6 addresses. This is the main entry point for
 * IP-level security checks.
 *
 * ## Detection Heuristic
 * If the IP contains a colon (`:`), it's treated as IPv6; otherwise IPv4.
 * This is reliable because:
 * - IPv4 dotted-quad never contains colons.
 * - IPv6 always contains at least one colon (even `::1` has two).
 *
 * @param ip - An IP address string (IPv4 dotted-quad or IPv6).
 * @returns `true` if the IP is in any private/reserved range.
 *
 * @example
 * ```ts
 * // IPv4 examples:
 * isPrivateIP("127.0.0.1");       // => true  (loopback)
 * isPrivateIP("10.0.0.1");        // => true  (RFC 1918 Class A)
 * isPrivateIP("172.16.0.1");      // => true  (RFC 1918 Class B)
 * isPrivateIP("192.168.1.1");     // => true  (RFC 1918 Class C)
 * isPrivateIP("169.254.169.254"); // => true  (AWS IMDS!)
 * isPrivateIP("8.8.8.8");         // => false (Google DNS -- public)
 * isPrivateIP("1.1.1.1");         // => false (Cloudflare DNS -- public)
 *
 * // IPv6 examples:
 * isPrivateIP("::1");             // => true  (loopback)
 * isPrivateIP("fc00::1");         // => true  (Unique Local Address)
 * isPrivateIP("fe80::1");         // => true  (Link-Local)
 * isPrivateIP("2607:f8b0:4004:800::200e"); // => false (Google -- public)
 * ```
 */
export function isPrivateIP(ip: string): boolean {
  // WHY check for colon: Simple and reliable heuristic. IPv4 addresses
  // never contain colons, and IPv6 addresses always do.
  if (ip.includes(":")) {
    // IPv6 path
    const expanded = expandIPv6(ip);
    return isIPv6Private(expanded);
  } else {
    // IPv4 path
    return isIPv4Private(ip);
  }
}

/**
 * Resolve a hostname via DNS and verify that none of its IP addresses
 * fall within private/reserved ranges.
 *
 * This is the primary SSRF prevention gate. It MUST be called before
 * every outbound HTTP request. The function resolves both A (IPv4) and
 * AAAA (IPv6) records and checks ALL of them -- a hostname is blocked
 * if even ONE of its addresses is private.
 *
 * ## Error Handling
 * - **Private IP detected:** Throws {@link SecurityError} with details
 *   about which IP and hostname triggered the block.
 * - **DNS resolution fails:** Throws {@link SecurityError}. We treat DNS
 *   failures as security events because they could indicate DNS rebinding
 *   attacks or other manipulation. The caller should NOT fall back to
 *   connecting directly -- that would bypass our protection.
 * - **No records found:** Throws {@link SecurityError}. A hostname with
 *   no A or AAAA records is unfetchable anyway.
 *
 * ## Why resolve BOTH A and AAAA?
 * A hostname might have only AAAA records pointing to `::1` (IPv6 loopback).
 * If we only checked A records, this attack vector would be missed.
 * Conversely, a hostname with only A records pointing to `127.0.0.1` must
 * be caught even if the AAAA resolution returns empty.
 *
 * ## DNS Rebinding Caveat
 * This function checks IPs at DNS resolution time, but the actual TCP
 * connection might use a different IP if the DNS response has a short TTL
 * and changes between our check and the HTTP library's connection. Full
 * DNS rebinding protection requires hooking into the HTTP library's
 * socket-level events. This is planned for Phase 2.
 *
 * @param hostname - The hostname to validate (e.g., "example.com", not a full URL).
 * @returns Resolves successfully if the hostname is safe to connect to.
 * @throws {SecurityError} If any resolved IP is private, or if DNS resolution fails.
 *
 * @example
 * ```ts
 * // Safe hostname:
 * await validateHostname("example.com"); // resolves successfully
 *
 * // Dangerous hostname (resolves to loopback):
 * await validateHostname("localhost");
 * // throws SecurityError: "Hostname 'localhost' resolves to private IP 127.0.0.1"
 *
 * // Non-existent hostname:
 * await validateHostname("does-not-exist.invalid");
 * // throws SecurityError: "DNS resolution failed for 'does-not-exist.invalid': ..."
 * ```
 */
export async function validateHostname(hostname: string): Promise<void> {
  // WHY we collect ALL IPs before checking: We want to report the
  // specific private IP in the error message for debugging. Collecting
  // all IPs also lets us check them all, rather than short-circuiting
  // on the first successful resolution.
  const allIPs: string[] = [];

  // Resolve A records (IPv4).
  // WHY try/catch per resolution: dns.resolve4 throws ENODATA if there
  // are no A records but AAAA records might exist. We don't want to
  // block a hostname just because it only has IPv6.
  try {
    const ipv4Addresses = await dns.resolve4(hostname);
    allIPs.push(...ipv4Addresses);
  } catch {
    // No A records -- this is fine if AAAA records exist.
    // We'll check for "no records at all" after both resolutions.
  }

  // Resolve AAAA records (IPv6).
  try {
    const ipv6Addresses = await dns.resolve6(hostname);
    allIPs.push(...ipv6Addresses);
  } catch {
    // No AAAA records -- this is fine if A records exist.
  }

  // If both resolutions failed and we have zero IPs, the hostname
  // is unresolvable. Treat this as a security event.
  if (allIPs.length === 0) {
    throw new SecurityError(
      `DNS resolution failed for '${hostname}': no A or AAAA records found. ` +
        `The hostname may not exist or DNS may be unreachable.`,
    );
  }

  // Check every resolved IP against private ranges.
  // WHY check ALL, not just the first: A dual-homed host might have
  // both public and private IPs. If ANY IP is private, the hostname
  // is considered unsafe because the HTTP library might connect to
  // the private one.
  for (const ip of allIPs) {
    if (isPrivateIP(ip)) {
      throw new SecurityError(
        `Hostname '${hostname}' resolves to private IP ${ip}. ` +
          `Request blocked to prevent SSRF. ` +
          `If this is intentional, configure an allow-list (Phase 2 feature).`,
      );
    }
  }

  // All IPs are public -- safe to proceed with the fetch.
}
