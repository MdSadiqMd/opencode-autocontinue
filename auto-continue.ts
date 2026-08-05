import type { Plugin, PluginInput, Hooks } from "@opencode-ai/plugin"

const TRANSIENT_ERROR = /503|502|504|529|429|queue is full|overloaded|timeout|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|stream (closed|ended|terminated)|connection (reset|refused)/i

const HARD_DENY = new Set([
  "MessageAbortedError",
  "ContextOverflowError",
  "ProviderAuthError",
  "ContentFilterError",
  "MessageOutputLengthError",
  "StructuredOutputError",
])

type Config = {
  maxConsecutive: number
  cooldownMs: number
  debounceMs: number
  debug: boolean
  dryRun: boolean
  text: string
}

const DEFAULT_TEXT = "continue"

const server: Plugin = async ({ client }: PluginInput): Promise<Hooks> => {
  const config: Config = {
    maxConsecutive: parseInt(process.env["OPENCODE_AUTOCONTINUE_MAX_CONSECUTIVE"] ?? "3", 10),
    cooldownMs: parseInt(process.env["OPENCODE_AUTOCONTINUE_COOLDOWN_MS"] ?? "5000", 10),
    debounceMs: parseInt(process.env["OPENCODE_AUTOCONTINUE_DEBOUNCE_MS"] ?? "3000", 10),
    debug: process.env["OPENCODE_AUTOCONTINUE_DEBUG"] === "true",
    dryRun: process.env["OPENCODE_AUTOCONTINUE_DRY_RUN"] === "true",
    text: process.env["OPENCODE_AUTOCONTINUE_TEXT"] ?? DEFAULT_TEXT,
  }

  const log = (msg: string, data?: Record<string, unknown>) => {
    if (!config.debug) return
    const line = data ? `${msg} ${JSON.stringify(data)}` : msg
    console.log(`[autocontinue] ${line}`)
  }

  const handled = new Set<string>()
  const episodes = new Map<string, { consecutive: number; lastInjectAt: number }>()

  log("Plugin loaded", { config: { ...config, text: config.text.slice(0, 20) + "..." } })

  return {
    async event({ event }) {
      if (event.type !== "message.updated") return

      const info = event.properties.info
      if (info.role !== "assistant" || !info.error || !info.time?.completed) return

      const { sessionID } = info
      const errorName = info.error.name
      const rawMessage = info.error.data.message
      const errorMsg = typeof rawMessage === "string" ? rawMessage : ""

      log("Error detected", { sessionID, messageID: info.id, errorName, errorMsg: errorMsg.slice(0, 100) })

      if (HARD_DENY.has(errorName)) {
        log("Ignoring hard-denied error", { errorName })
        return
      }

      if (!TRANSIENT_ERROR.test(errorMsg)) {
        log("Ignoring non-transient error", { errorName, errorMsg: errorMsg.slice(0, 50) })
        return
      }

      if (handled.has(info.id)) {
        log("Already handled", { messageID: info.id })
        return
      }

      const ep = episodes.get(sessionID) ?? { consecutive: 0, lastInjectAt: 0 }
      const now = Date.now()

      if (ep.consecutive >= config.maxConsecutive) {
        log("Max consecutive reached", { sessionID, consecutive: ep.consecutive })
        return
      }

      if (ep.lastInjectAt > 0 && now - ep.lastInjectAt < config.cooldownMs) {
        log("Cooldown active", { sessionID, remainingMs: config.cooldownMs - (now - ep.lastInjectAt) })
        return
      }

      handled.add(info.id)

      log("Will inject continue", { sessionID, messageID: info.id, attempt: ep.consecutive + 1 })

      await new Promise(r => setTimeout(r, config.debounceMs))

      if (config.dryRun) {
        log("DRY RUN - would inject continue", { sessionID })
        return
      }

      try {
        const result = await client.session.prompt({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: config.text }] },
        })

        if (result.error) {
          log("Inject failed", { sessionID, error: JSON.stringify(result.error) })
        } else {
          log("Inject successful", { sessionID, attempt: ep.consecutive + 1 })
          ep.consecutive++
          ep.lastInjectAt = Date.now()
          episodes.set(sessionID, ep)
        }
      } catch (err) {
        log("Inject exception", { sessionID, error: String(err) })
      }
    },
  }
}

export default { id: "auto-continue", server }