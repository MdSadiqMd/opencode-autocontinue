# opencode-autocontinue

A plugin for [opencode](https://opencode.ai) that automatically resumes interrupted AI conversations

## The Problem

When using opencode with AI providers, you sometimes encounter transient errors mid-conversation:

```
Streaming response failed: [503] The request queue is full
```

The AI stops mid-response, and you have to manually type "continue" to resume. This is especially frustrating during long-running agent tasks that might fail at 3 AM.

## The Solution

This plugin watches for transient errors and automatically sends "continue" to resume the conversation. No manual intervention needed.

## Installation

```bash
mkdir -p ~/.config/opencode/plugin
curl -o ~/.config/opencode/plugin/auto-continue.ts \
  https://raw.githubusercontent.com/MdSadiqMd/opencode-autocontinue/main/auto-continue.ts
```

Or clone and copy:

```bash
git clone https://github.com/MdSadiqMd/opencode-autocontinue.git
cp opencode-autocontinue/auto-continue.ts ~/.config/opencode/plugin/
```

Restart opencode. The plugin loads automatically.

## Errors that trigger auto-continue

| Error | Example |
|-------|---------|
| Server overload | `[503] The request queue is full` |
| Bad gateway | `[502] Bad Gateway` |
| Rate limiting | `[429] Too Many Requests` |
| Timeouts | `timeout`, `ETIMEDOUT` |
| Network issues | `ECONNRESET`, `socket hang up`, `fetch failed` |
| Stream errors | `stream closed`, `connection reset` |

## Errors that are ignored (by design)

| Error | Why |
|-------|-----|
| User abort (ESC key) | You stopped it intentionally |
| Context overflow | opencode handles this with auto-compaction |
| Auth errors | You need to fix your API key |
| Content filter | Policy violation needs review |
| 4xx client errors | These aren't transient |

## Configuration

All settings are optional. The defaults work well for most cases.

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `OPENCODE_AUTOCONTINUE_DEBUG` | `false` | Show debug logs |
| `OPENCODE_AUTOCONTINUE_DRY_RUN` | `false` | Log but don't actually inject |
| `OPENCODE_AUTOCONTINUE_MAX_CONSECUTIVE` | `3` | Stop after N consecutive failures |
| `OPENCODE_AUTOCONTINUE_COOLDOWN_MS` | `5000` | Wait between retries |
| `OPENCODE_AUTOCONTINUE_DEBOUNCE_MS` | `3000` | Wait before first retry |
| `OPENCODE_AUTOCONTINUE_TEXT` | `continue` | Message to send |

### Enable debug logging

```bash
OPENCODE_AUTOCONTINUE_DEBUG=true opencode
```

### Dry run (test without injecting)

```bash
OPENCODE_AUTOCONTINUE_DRY_RUN=true OPENCODE_AUTOCONTINUE_DEBUG=true opencode
```

## How it works

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   opencode  │────▶│    Plugin    │────▶│  Provider   │
│             │     │              │     │             │
│  message.   │     │ Is error     │     │  "continue" │
│  updated    │     │ transient?   │     │             │
│  (error)    │     │ Yes → inject │     │             │
└─────────────┘     └──────────────┘     └─────────────┘
```

1. Plugin listens for `message.updated` events
2. When an assistant message fails with an error:
   - Check if it's a "hard deny" error (user abort, auth) → ignore
   - Check if error matches transient patterns → inject "continue"
3. Rate limiting prevents infinite loops (max 3 consecutive, 5s cooldown)

## Testing locally

You can test without waiting for a real provider outage.

#### 1. Start a mock server that fails then succeeds

```bash
bun -e '
let count = 0
Bun.serve({
  port: 9999,
  fetch(req) {
    if (req.method === "POST" && req.url.includes("/chat/completions")) {
      count++
      if (count === 1) {
        // First request: partial response then 503
        return new Response(`data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Working on it..."}}]}

data: {"error":{"message":"[503] The request queue is full"}}

`, { headers: { "Content-Type": "text/event-stream" } })
      }
      // After auto-continue: success
      return new Response(`data: {"id":"2","object":"chat.completion.chunk","choices":[{"delta":{"content":"Done! Auto-continue worked."}}]}

data: {"id":"2","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop"}]}

data: [DONE]

`, { headers: { "Content-Type": "text/event-stream" } })
    }
    return new Response("ok")
  }
})
console.log("Mock server ready on :9999")
'
```

#### 2. Point opencode at the mock

```bash
mkdir -p /tmp/test && cd /tmp/test
echo '{"provider":{"opencode":{"options":{"baseURL":"http://127.0.0.1:9999/v1"}}}}' > opencode.json
```

#### 3. Run with debug logging

```bash
OPENCODE_AUTOCONTINUE_DEBUG=true opencode
```

#### 4. Select any "opencode" provider model and send a message

You'll see:
1. `"Working on it..."` then error
2. Plugin logs: `Will inject continue`
3. `"Done! Auto-continue worked."`

## Requirements

- opencode v0.1.0 or later
- The plugin uses opencode's built-in plugin system (no dependencies)

## License

MIT
