# opencode-jev

TypeSafe **Jev** skill-suggestion plugin for [OpenCode](https://opencode.ai).

On every user message, this plugin makes **two cheap TypeSafe System One calls** and
injects a non-binding `<skill_relevance>` block into the system prompt, telling the
agent which skill from the roster is most likely relevant — or that none is.

It implements the [TypeSafe skill-suggestion recipe](https://docs.typesafe.ai/cookbooks/skill_suggestion),
which measured on a 182-skill roster:

| | wrong skill loads | needless loads |
| --- | --- | --- |
| agent alone | 16.8% | 9.8% |
| **with this suggestion** | **7.3%** | **4.0%** |

## Why

Agents with large skill rosters choose from a truncated index. They load the wrong
skill on lookalike requests and load one at all even when nothing fits, wasting the
main LLM's context and tokens. Jev ranks the whole roster and gates on "does this
turn need a skill?" for pennies per judgment, *before* the main model runs — the
coding LLM never pays for the routing decision.

## Install

Requires a [TypeSafe API key](https://console.typesafe.ai/keys).

```bash
npm install opencode-jev   # or let opencode resolve it
```

Add to `opencode.json` (project) or `~/.config/opencode/opencode.jsonc` (global):

```jsonc
{
  "plugin": [
    // option A: key via environment variable (recommended)
    "opencode-jev",

    // option B: key inline in config
    ["opencode-jev", { "apiKey": "your-typesafe-key" }]
  ]
}
```

Restart opencode. Look for `service: "opencode-jev"` log lines to confirm it is
running (`roster scanned: N skills`).

## Configuration

All options are optional and can be passed in the plugin tuple or via environment
variables (options win):

| Option | Env | Default | Meaning |
| --- | --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | – | TypeSafe API key |
| `model` | `TYPESAFE_MODEL` | `jev-latest` | System One model |
| `baseURL` | `TYPESAFE_ENDPOINT` | – | Custom API endpoint |
| `timeoutMs` | `JEV_TIMEOUT_MS` | `8000` | Per-request timeout; also the max wait before the LLM call proceeds without a suggestion |
| `gateThreshold` | `JEV_GATE_THRESHOLD` | `0.30` | Mean of the gate nouls below which nothing is suggested |
| `fitsThreshold` | `JEV_FITS_THRESHOLD` | `0.30` | Best fit-noul below which the shortlist is rejected |
| `shortlistSize` | – | `3` | Candidates carried into the rerank request |
| `maxRoster` | – | `400` | Cap on scanned skills per request |
| `rosterDirs` | – | – | Extra directories to scan for `*/SKILL.md` |
| `enabled` | – | `true` | Disable the plugin without uninstalling |

Skill roster sources (first occurrence of a name wins): the current worktree's
`.opencode/skill(s)`, `.agents/skills`, `.claude/skills`, plus global
`~/.config/opencode/skills`, `~/.claude/skills`, `~/.agents/skills`.

## How it works

```
user message
  └─ chat.message hook ──► TypeSafe request 1: Choice over the whole roster
                           + 3 gate Nouls ("does this turn need a skill at all?")
  └─ gate < threshold ───► suggest nothing
  └─ TypeSafe request 2 ─► Choice over top-3 with full descriptions
                           + per-candidate fit Nouls ("does it do THIS?")
  └─ system.transform ──► <skill_relevance>Relevant to the current request: …
                           (or an explicit "no skill relevant" line)
```

The block is advisory: the agent keeps its full roster and can ignore the
suggestion. The roster text is never modified, so prefix caching still holds.

**Failure-safe by contract.** Missing key, network errors, timeouts, and rate
limits all degrade to "no block" — the plugin never throws into your session.

## Limitations

- Thresholds were calibrated on an English dataset; validate on your own roster
  and adjust `gateThreshold` / `fitsThreshold` before trusting the gate.
- Jev handles CJK (Chinese/Japanese/Korean) text but with lower accuracy than
  English; pay attention to the log output on non-English requests.
- Rosters beyond ~400 skills should be chunked; this plugin caps and truncates.

## Development

```bash
npm install
npm run typecheck
npm run smoke          # set TYPESAFE_API_KEY to also exercise the live call path
npm run build
```

## License

MIT
