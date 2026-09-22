/**
 * Jev plugin hooks for OpenCode.
 *
 * On each user message, runs the TypeSafe skill-suggestion recipe
 * (see skills.ts) and, while assembling the system prompt for that session,
 * appends a non-binding <skill_relevance> block. The block only tells the
 * agent which roster entry to look at first; it never forces a load, and a
 * turn with no relevant skill still gets an explicit "none relevant" line to
 * counter the roster's load-everything pressure.
 *
 * Failure-safe by contract: no API key, network errors, or timeouts degrade
 * to "no block", never an exception into the session.
 *
 * Configure via the opencode.json plugin tuple:
 *
 *   "plugin": [
 *     ["opencode-jev", { "apiKey": "...", "model": "jev-latest" }]
 *   ]
 *
 * Every option falls back to environment variables (TYPESAFE_API_KEY,
 * TYPESAFE_MODEL, TYPESAFE_ENDPOINT, JEV_TIMEOUT_MS, JEV_GATE_THRESHOLD,
 * JEV_FITS_THRESHOLD) and then to defaults.
 */
import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import {
  JevSuggester,
  scanRoster,
  suggestionBlock,
  type JevConfig,
  type SkillEntry,
} from "./skills.js"

export type JevPluginOptions = JevConfig & {
  /** Set false to disable the plugin entirely. */
  enabled?: boolean
}

const BLOCK_TTL_MS = 10 * 60 * 1000
const MIN_REQUEST_CHARS = 4

function extractText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  const chunks: string[] = []
  for (const part of parts as Array<{ type?: string; text?: unknown }>) {
    if (part && part.type === "text" && typeof part.text === "string") {
      chunks.push(part.text)
    }
  }
  return chunks.join("\n").trim()
}

function rosterDirs(worktree: string, extraDirs: string[]): string[] {
  const home = os.homedir()
  const candidates = [
    ...extraDirs,
    path.join(home, ".config", "opencode", "skills"),
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(worktree, ".opencode", "skills"),
    path.join(worktree, ".opencode", "skill"),
    path.join(worktree, ".agents", "skills"),
    path.join(worktree, ".claude", "skills"),
  ]
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const candidate of candidates) {
    if (!candidate) continue
    const resolved = path.isAbsolute(candidate) ? candidate : path.resolve(worktree, candidate)
    if (seen.has(resolved)) continue
    seen.add(resolved)
    try {
      if (fs.statSync(resolved).isDirectory()) dirs.push(resolved)
    } catch {
      // skip missing directories
    }
  }
  return dirs
}

export const JevHooksPlugin = async (
  { worktree, client }: PluginInput,
  options: JevPluginOptions = {},
): Promise<Hooks> => {
  const enabled = options.enabled ?? true
  const suggester = new JevSuggester(options)

  const pending = new Map<string, { promise: Promise<string>; startedAt: number }>()
  const blocks = new Map<string, { text: string; at: number }>()
  let roster: SkillEntry[] | null = null

  const log = (level: "debug" | "info" | "warn" | "error", message: string) =>
    client.app.log({ body: { service: "opencode-jev", level, message } }).catch(() => {})

  const getRoster = async (): Promise<SkillEntry[]> => {
    if (roster) return roster
    roster = scanRoster(
      rosterDirs(worktree || process.cwd(), options.rosterDirs ?? []),
      options.maxRoster,
    )
    await log(
      "info",
      `roster scanned: ${roster.length} skills${suggester.enabled ? "" : " (disabled: no API key)"}`,
    )
    return roster
  }

  const runSuggestion = async (sessionID: string, request: string) => {
    const startedAt = Date.now()
    const entries = suggester.enabled ? await suggester.suggest(request, await getRoster()) : []
    const text = suggestionBlock(entries.map((entry) => entry.name))
    blocks.set(sessionID, { text, at: Date.now() })
    pending.delete(sessionID)
    if (suggester.enabled) {
      await log(
        "debug",
        `suggested [${entries.map((e) => e.name).join(", ") || "none"}] in ${Date.now() - startedAt}ms`,
      )
    }
    return text
  }

  return {
    "chat.message": async (input, output) => {
      if (!enabled || !suggester.enabled) return
      const request = extractText(output.parts)
      if (request.length < MIN_REQUEST_CHARS) return
      const task = runSuggestion(input.sessionID, request)
      pending.set(input.sessionID, { promise: task, startedAt: Date.now() })
      task.catch(() => pending.delete(input.sessionID))
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const inflight = pending.get(input.sessionID)
      if (inflight) {
        const budget = suggester.timeoutMs
        const remaining = Math.max(0, budget - (Date.now() - inflight.startedAt))
        await Promise.race([
          inflight.promise,
          new Promise((resolve) => setTimeout(resolve, remaining)),
        ]).catch(() => {})
      }
      const block = blocks.get(input.sessionID)
      if (block && Date.now() - block.at < BLOCK_TTL_MS) {
        output.system.push(block.text)
      }
    },
  }
}

export default JevHooksPlugin
