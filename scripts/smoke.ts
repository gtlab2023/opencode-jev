/**
 * Smoke test: verifies the plugin loads, the roster scanner parses real
 * SKILL.md frontmatter, and the no-key / bad-key failure paths stay silent.
 * Run: npm run smoke  (set TYPESAFE_API_KEY to also exercise live calls)
 */
import * as os from "os"
import * as path from "path"
import { JevSuggester, scanRoster, suggestionBlock } from "../src/skills.js"
import JevHooksPlugin from "../src/index.js"

const home = os.homedir()
const dirs = [
  path.join(home, ".config/opencode/skills"),
  path.join(home, ".claude/skills"),
  path.join(home, ".agents/skills"),
].filter((d) => {
  try {
    return require("fs").statSync(d).isDirectory()
  } catch {
    return false
  }
})

const roster = scanRoster(dirs)
console.log("roster size:", roster.length)
console.log("unique:", new Set(roster.map((r) => r.name)).size === roster.length)
console.log("block:", JSON.stringify(suggestionBlock(["some-skill"])))

const noKey = new JevSuggester({})
console.log("enabled (no key):", noKey.enabled)
console.log("no-key suggest:", JSON.stringify(await noKey.suggest("test", roster)))

const hooks = await JevHooksPlugin(
  {
    client: { app: { log: async () => {} } },
    worktree: process.cwd(),
    directory: process.cwd(),
    $: {},
  } as never,
  { enabled: false },
)
console.log("hooks registered:", Object.keys(hooks).join(", "))

if (process.env.TYPESAFE_API_KEY) {
  process.env.TYPESAFE_API_KEY = "sk-invalid-error-path-check"
  const badKey = new JevSuggester({ timeoutMs: 8000 })
  const t0 = Date.now()
  const result = await badKey.suggest("fix a bug", roster.slice(0, 5))
  console.log("bad-key suggest (must be []):", JSON.stringify(result), "in", Date.now() - t0, "ms")
} else {
  console.log("live-call check skipped (no TYPESAFE_API_KEY)")
}
