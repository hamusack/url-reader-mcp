# Conventions — url-reader-mcp

## TypeScript & Module System

- **Target**: ES2022, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`
- **Import extensions**: Always `.js` even for `.ts` source files
  ```typescript
  // Correct
  import { config } from "./config.js";
  // Wrong — will fail at runtime
  import { config } from "./config";
  import { config } from "./config.ts";
  ```
- **Package type**: `"type": "module"` in package.json — all `.js` files are ES modules
- **Strict mode**: `"strict": true` in tsconfig. No `any` unless absolutely necessary.

## MCP SDK Patterns (v1.6.1)

### Tool Schema

Schema is a **plain Zod object** — NOT wrapped in `z.object()`:

```typescript
// Correct — plain object
export const MyToolSchema = {
  url: z.string().url().describe("Target URL"),
  limit: z.number().optional().default(100).describe("Max results"),
};

// Wrong — SDK wraps it internally
export const MyToolSchema = z.object({
  url: z.string().url(),
});
```

### Tool Registration

```typescript
server.tool("tool_name", "Human-readable description", Schema, handler);
```

- Tool name: `snake_case`
- Description: concise, starts with a verb
- Schema: exported from `tools/xxx.ts`
- Handler: exported from `tools/xxx.ts`

### Handler Return Format

```typescript
// Success
return {
  content: [{ type: "text" as const, text: "result string" }],
};

// Error (use the helper)
return formatErrorForMcp(error);
// Produces: { content: [{ type: "text", text: "..." }], isError: true }
```

## Error Handling

### Hierarchy

```
UrlReaderError (base) — has `code: string`
  ├── FetchError          — "FETCH_FAILED", optional statusCode
  ├── SecurityError       — "SSRF_BLOCKED"
  ├── ExtractionError     — "EXTRACTION_FAILED"
  ├── TimeoutError        — "TIMEOUT"
  └── TokenLimitError     — "TOKEN_LIMIT_REACHED"
```

### Pattern

```typescript
import { FetchError, formatErrorForMcp } from "../utils/errors.js";

export async function handleMyTool(params: { url: string }) {
  try {
    // ... business logic ...
    return { content: [{ type: "text" as const, text: result }] };
  } catch (error) {
    return formatErrorForMcp(error);
  }
}
```

### Adding a New Error

```typescript
export class MyNewError extends UrlReaderError {
  constructor(message: string) {
    super(message, "MY_NEW_CODE");
  }
}
```

## Configuration Pattern

- **Single source**: `config.ts` exports a `config` singleton + `loadConfig()` factory
- **Env var naming**: `SCREAMING_SNAKE_CASE`
- **All values have defaults** — zero-config startup guaranteed
- **Never read `process.env` outside `config.ts`**

```typescript
// In any module:
import { config } from "./config.js";
const timeout = config.fetchTimeout; // number, already parsed
```

## Testing

### Framework

- **Runner**: Bun (`bun test`)
- **API**: `describe`, `it`, `expect` — Bun built-ins, no imports needed
- **No mocking library** — tests target pure functions

### File Layout

```
tests/
├── utils/
│   ├── url.test.ts              # URL normalization, domain extraction
│   └── network.test.ts          # SSRF private IP detection
├── crawler/
│   ├── token-counter.test.ts    # Token estimation
│   └── link-resolver.test.ts    # Link resolution, filtering
└── extractor/
    ├── html-extractor.test.ts   # HTML article extraction
    └── markdown-converter.test.ts # HTML → Markdown conversion
```

### Conventions

- Test file mirrors source file path: `src/utils/url.ts` → `tests/utils/url.test.ts`
- Use `example.com` for all test URLs — never real URLs
- Group with `describe("functionName", ...)`, individual cases with `it("should ...", ...)`
- Test edge cases: empty input, malformed URLs, CJK content, huge inputs

### Example

```typescript
import { describe, it, expect } from "bun:test";
import { normalizeUrl } from "../../src/utils/url.js";

describe("normalizeUrl", () => {
  it("should strip trailing slashes", () => {
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
  });

  it("should lowercase the hostname", () => {
    expect(normalizeUrl("https://EXAMPLE.COM/path")).toBe("https://example.com/path");
  });
});
```

## Build (esbuild)

### Config: `build.ts`

```typescript
await build({
  entryPoints: ["./src/index.ts"],
  bundle: true,
  minify: true,
  platform: "node",
  target: "node18",
  outfile: "./build/index.js",
  format: "esm",
  banner: {
    js: `#!/usr/bin/env node
import { createRequire } from 'module';
const require = createRequire(import.meta.url);`,
  },
  external: ["jsdom"],
});
```

### Critical Gotchas

1. **`createRequire` banner is mandatory**: Without it, packages using `require()` fail with "Dynamic require of X is not supported" at runtime.

2. **`jsdom` must be `external`**: jsdom loads `xhr-sync-worker.js` via dynamic file path at runtime. Bundling breaks this. It must load from `node_modules/`.

3. **Both are required together**: Removing either one causes the server to crash on startup.

4. **JSDoc `*/` pattern**: Never put `*/` inside JSDoc comments (e.g., glob examples). esbuild's minifier interprets it as comment-end, producing syntax errors.
   ```typescript
   // Bad — breaks esbuild
   /** @example ["*/login/*"] */

   // Good — safe alternative
   /** @example ["login", "admin"] */
   ```

5. **Adding new external packages**: If a new dependency has dynamic file loading or native modules, add it to the `external` array in `build.ts`.

## Code Style

- **JSDoc**: All exported functions and classes have JSDoc. Include `@module` and `@fileoverview` at the top of each file.
- **Comments**: Use `// ---` section dividers for logical blocks within a file.
- **Naming**: camelCase for variables/functions, PascalCase for classes/types, SCREAMING_SNAKE for env vars.
- **No default exports**: Always use named exports.
- **Type assertions**: Use `as const` for literal types in MCP responses (`type: "text" as const`).
