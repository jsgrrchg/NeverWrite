# ACP adapter for Codex

Use [Codex](https://github.com/openai/codex) from [ACP-compatible](https://agentclientprotocol.com) clients such as [Zed](https://zed.dev)!

This tool implements an ACP adapter around the Codex CLI, supporting:

- Context @-mentions
- Images
- Tool calls (with permission requests)
- Following
- Edit review
- TODO lists
- Slash commands:
  - /review (with optional instructions)
  - /review-branch
  - /review-commit
  - /init
  - /compact
  - /logout
- Client MCP servers
- Auth Methods:
  - ChatGPT subscription (requires paid subscription and doesn't work in remote projects)
  - CODEX_API_KEY
  - OPENAI_API_KEY

Learn more about the [Agent Client Protocol](https://agentclientprotocol.com/).

## NeverWrite compatibility boundary

NeverWrite's vendored build keeps the ACP Rust SDK at `0.14.0` and the wire protocol at ACP v1 while running the OpenAI Codex `rust-v0.153.2` crates.

MCP protocol `2026-07-28` remains disabled for this adapter because ACP `0.14.0` does not provide the trusted client-extension boundary required to adopt it; client-provided stdio environment variables, HTTP headers, working directories, and existing server authentication or approval configuration remain supported through the legacy MCP path.

## How to use

### Zed

The latest version of Zed can already use this adapter out of the box.

To use Codex, open the Agent Panel and click "New Codex Thread" from the `+` button menu in the top-right.

Read the docs on [External Agent](https://zed.dev/docs/ai/external-agents) support.

### Other clients

Or try it with any of the other [ACP compatible clients](https://agentclientprotocol.com/overview/clients)!

#### Installation

Install the adapter from the latest release for your architecture and OS: https://github.com/zed-industries/codex-acp/releases

You can then use `codex-acp` as a regular ACP agent:

```
OPENAI_API_KEY=sk-... codex-acp
```

Or via npm:

```
npx @zed-industries/codex-acp
```

## License

Apache-2.0
