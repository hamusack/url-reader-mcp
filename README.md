# mcp-url-reader

URLからWebページのコンテンツを抽出し、クリーンなMarkdownとして返すMCPサーバー。
リンクを辿って再帰的に情報を収集するクロール機能も備えている。

## Architecture

```
MCP Client (Claude Desktop / Claude Code)
  |
  | stdio (JSON-RPC over stdin/stdout)
  v
index.ts -- McpServer
  |
  +-- read_url     --> extractor/pipeline.ts --> services/fetch.ts
  +-- crawl        --> crawler/bfs-crawler.ts --> extractor/pipeline.ts
  +-- extract_links --> crawler/link-resolver.ts --> services/fetch.ts
```

### Module Dependency Graph

```
  +----------+   +----------+   +----------+
  |  tools/  |   | crawler/ |   | services/|
  +----+-----+   +----+-----+   +----+-----+
       |              |              |
       +------+-------+------+------+
              |              |
        +-----v-----+  +----v----+
        |  config.ts |  | utils/  |
        +-----------+  +---------+
```

### Directory Structure

```
mcp-url-reader/
├── package.json              # Dependencies & scripts
├── tsconfig.json             # TypeScript config (removeComments: false)
├── build.ts                  # esbuild bundler config
├── .gitignore
├── README.md                 # This file
└── src/
    ├── index.ts              # Entry point (server + tool registration)
    ├── config.ts             # Environment variables -> AppConfig
    ├── utils/
    │   ├── errors.ts         # Custom error hierarchy (UrlReaderError base)
    │   ├── url.ts            # URL normalization, domain extraction, pattern matching
    │   └── network.ts        # SSRF protection (private IP detection)
    ├── services/
    │   ├── cache.ts          # node-cache TTL cache wrapper
    │   ├── queue.ts          # p-queue concurrency control (global + per-domain)
    │   └── fetch.ts          # Secure HTTP client with SSRF/timeout/size limits
    ├── extractor/
    │   ├── html-extractor.ts # cheerio preprocessing + Readability article extraction
    │   ├── markdown-converter.ts # turndown HTML -> Markdown conversion
    │   └── pipeline.ts       # Unified fetch -> extract -> convert pipeline
    ├── crawler/
    │   ├── token-counter.ts  # Token count estimation (CJK-aware)
    │   ├── link-resolver.ts  # Link discovery, resolution, filtering
    │   └── bfs-crawler.ts    # BFS crawl engine with token budget control
    └── tools/
        ├── read-url.ts       # read_url tool (schema + handler)
        ├── crawl.ts          # crawl tool (schema + handler)
        └── extract-links.ts  # extract_links tool (schema + handler)
```

## Tools

### `read_url`

単一URLを取得し、本文をクリーンなMarkdownで返す。

| Parameter      | Type    | Required | Default | Description                          |
|---------------|---------|----------|---------|--------------------------------------|
| `url`          | string  | Yes      | -       | 取得するURL (http/https)              |
| `max_length`   | number  | No       | 50000   | 返却するMarkdownの最大文字数           |
| `include_links`| boolean | No       | true    | ページ内のリンク一覧を含めるか         |

**例:**
```json
{
  "tool": "read_url",
  "arguments": {
    "url": "https://example.com/article",
    "max_length": 30000,
    "include_links": true
  }
}
```

### `crawl`

BFS（幅優先探索）でリンクを辿りながらコンテンツを収集する。
トークン予算に達するか、探索可能なページがなくなると停止する。

| Parameter          | Type     | Required | Default  | Description                                 |
|-------------------|----------|----------|----------|---------------------------------------------|
| `url`              | string   | Yes      | -        | クロール開始URL                              |
| `max_tokens`       | number   | No       | 100000   | 収集する最大トークン数                        |
| `allowed_domains`  | string[] | No       | 開始URLのドメイン | クロール対象ドメイン                   |
| `exclude_patterns` | string[] | No       | -        | 除外するURLパターン                           |
| `include_patterns` | string[] | No       | -        | このパターンに一致するURLのみ辿る             |

**例:**
```json
{
  "tool": "crawl",
  "arguments": {
    "url": "https://docs.example.com",
    "max_tokens": 50000,
    "allowed_domains": ["docs.example.com"],
    "exclude_patterns": ["api-reference"]
  }
}
```

### `extract_links`

ページ上の全ハイパーリンクを抽出して一覧で返す。

| Parameter | Type   | Required | Default | Description                                        |
|-----------|--------|----------|---------|----------------------------------------------------|
| `url`     | string | Yes      | -       | リンクを抽出するURL                                 |
| `filter`  | string | No       | "all"   | `"all"`, `"internal"` (同一ドメイン), `"external"` (外部ドメイン) |

**例:**
```json
{
  "tool": "extract_links",
  "arguments": {
    "url": "https://example.com",
    "filter": "external"
  }
}
```

## Installation

### Prerequisites

- Node.js >= 18.0.0
- [Bun](https://bun.sh/) (for building and testing)

### Build

```bash
cd mcp-url-reader
bun install
bun run build
```

ビルド成果物は `./build/index.js` に出力される（単一バンドル + shebang付き）。

### Claude Code に設定する

`~/.claude/settings.json` の `mcpServers` に追加:

```json
{
  "mcpServers": {
    "url-reader": {
      "command": "node",
      "args": ["/path/to/mcp-url-reader/build/index.js"]
    }
  }
}
```

### Claude Desktop に設定する

`claude_desktop_config.json` に追加:

```json
{
  "mcpServers": {
    "url-reader": {
      "command": "node",
      "args": ["/path/to/mcp-url-reader/build/index.js"]
    }
  }
}
```

## Configuration

環境変数で動作をカスタマイズできる。全てにデフォルト値があるため、設定なしでも動作する。

| Environment Variable   | Default                          | Description                       |
|-----------------------|----------------------------------|-----------------------------------|
| `DEFAULT_MAX_LENGTH`   | `50000`                          | read_urlのデフォルト最大文字数      |
| `DEFAULT_MAX_TOKENS`   | `100000`                         | crawlのデフォルト最大トークン数     |
| `FETCH_TIMEOUT`        | `10000`                          | HTTP タイムアウト (ms)             |
| `CACHE_TTL`            | `3600`                           | キャッシュTTL (秒)                 |
| `MAX_CONCURRENT`       | `3`                              | グローバル同時接続数               |
| `PER_DOMAIN_INTERVAL`  | `2000`                           | 同一ドメインへのリクエスト間隔 (ms) |
| `MAX_RESPONSE_SIZE`    | `10485760`                       | レスポンスボディ最大サイズ (bytes)  |
| `MAX_REDIRECTS`        | `5`                              | 最大リダイレクト回数               |
| `USER_AGENT`           | `mcp-url-reader/1.0 (MCP Server)` | User-Agentヘッダー               |

## Security

### SSRF Protection

- リクエスト前にDNS解決し、プライベートIPアドレス (127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, ::1, fc00::/7) をブロック
- http / https プロトコルのみ許可

### Content Safety

- Content-Type検証: HTML系のみ受理 (text/html, application/xhtml+xml, text/xml, application/xml)
- レスポンスサイズ制限: ストリーミング読み込みでバイト数を監視
- リダイレクト回数制限: 無限リダイレクトループを防止
- タイムアウト: AbortSignal.timeout() による接続タイムアウト

### Rate Limiting

- グローバル同時接続数制限 (デフォルト3)
- ドメイン別レート制限 (デフォルト2秒間隔)

## Testing

```bash
bun test
```

テストは `tests/` ディレクトリに配置:
- `tests/utils/url.test.ts` — URL正規化・ドメイン抽出
- `tests/utils/network.test.ts` — SSRF保護 (プライベートIP判定)
- `tests/crawler/token-counter.test.ts` — トークン数推定
- `tests/extractor/html-extractor.test.ts` — HTML本文抽出
- `tests/extractor/markdown-converter.test.ts` — Markdown変換
- `tests/crawler/link-resolver.test.ts` — リンク解決・フィルタ

## Extension Guide

### 新しいツールを追加する

1. `src/tools/` に新ファイルを作成
2. Zod schemaオブジェクト（`z.object()` で**ラップしない**）とhandler関数をexport
3. `src/index.ts` で `server.tool()` を呼んで登録

```typescript
// src/tools/my-tool.ts
import { z } from "zod";

export const MyToolSchema = {
  param1: z.string().describe("Description"),
};

export async function handleMyTool(params: { param1: string }) {
  // ...
  return { content: [{ type: "text" as const, text: "result" }] };
}
```

```typescript
// src/index.ts に追加
import { MyToolSchema, handleMyTool } from "./tools/my-tool.js";
server.tool("my_tool", "Description", MyToolSchema, handleMyTool);
```

### 新しいエラー種別を追加する

`src/utils/errors.ts` に `UrlReaderError` のサブクラスを追加:

```typescript
export class MyCustomError extends UrlReaderError {
  constructor(message: string) {
    super(message, "MY_CUSTOM_CODE");
  }
}
```

### Phase 2 拡張候補

- **Jina AI Reader API**: JavaScript実行が必要なSPA対応
- **ブラウザ連携**: Playwright/Puppeteerによる動的レンダリング
- **robots.txt対応**: クロール制限の尊重

### Phase 3 拡張候補

- **HTTP/SSE transport**: リモートアクセス対応
- **MCP Resources**: クロールセッション履歴・キャッシュページの公開
- **PDF/Docx対応**: バイナリドキュメントからのテキスト抽出

## Tech Stack

| Library | Purpose |
|---------|---------|
| [@modelcontextprotocol/sdk](https://www.npmjs.com/package/@modelcontextprotocol/sdk) v1.6.1 | MCP server framework |
| [cheerio](https://www.npmjs.com/package/cheerio) | HTML parsing & link extraction |
| [@mozilla/readability](https://www.npmjs.com/package/@mozilla/readability) | Article content extraction |
| [jsdom](https://www.npmjs.com/package/jsdom) | DOM API for Readability |
| [turndown](https://www.npmjs.com/package/turndown) | HTML to Markdown conversion |
| [node-cache](https://www.npmjs.com/package/node-cache) | In-memory TTL cache |
| [p-queue](https://www.npmjs.com/package/p-queue) | Concurrency control |
| [zod](https://www.npmjs.com/package/zod) | Schema validation |

## License

MIT
