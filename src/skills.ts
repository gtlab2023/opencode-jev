/**
 * Core: TypeSafe System One skill suggestion.
 *
 * Implements the two-request recipe from
 * https://docs.typesafe.ai/cookbooks/skill_suggestion :
 * 1. one fan-out request ranking the whole roster (Choice) plus gate Nouls
 *    ("does this turn need a skill at all?"),
 * 2. one rerank request over the top candidates with per-candidate fit Nouls.
 *
 * Failure-safe by contract: any error, timeout, or missing API key results in
 * "no suggestion", never an exception escaping into the session.
 */
import * as fs from "fs"
import * as path from "path"
import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk"

export interface SkillEntry {
  name: string
  description: string
}

export interface JevConfig {
  apiKey?: string
  baseURL?: string
  model?: string
  timeoutMs?: number
  gateThreshold?: number
  fitsThreshold?: number
  shortlistSize?: number
  maxRoster?: number
  rosterDirs?: string[]
}

export const DEFAULTS = {
  apiKey: undefined as string | undefined,
  baseURL: undefined as string | undefined,
  model: "jev-latest",
  timeoutMs: 8000,
  gateThreshold: 0.3,
  fitsThreshold: 0.3,
  shortlistSize: 3,
  maxRoster: 400,
  rosterDirs: [] as string[],
}

const GATE_QUESTIONS: Record<string, string> = {
  acts_on_user_system:
    "Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
  would_follow_documented_procedure:
    "Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
  prose_suffices:
    "Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
}
const INVERTED = new Set(["prose_suffices"])

const WIDE_INSTRUCTIONS =
  "Which of these skills, if any, is the right one to load to help with the user's latest request?"
const RERANK_INSTRUCTIONS =
  "Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name."
const WIDE_DESC_CHARS = 240
const RERANK_DESC_CHARS = 700

function parseFrontmatter(text: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!match) return {}
  const out: { name?: string; description?: string } = {}
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line)
    if (!kv) continue
    const value = kv[2].trim().replace(/^["']|["']$/g, "")
    if (kv[1] === "name" && value) out.name = value
    if (kv[1] === "description" && value) out.description = value
  }
  return out
}

function scanSkillDir(dir: string): SkillEntry[] {
  const found: SkillEntry[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = path.join(dir, entry.name, "SKILL.md")
    let text: string
    try {
      text = fs.readFileSync(skillFile, "utf8")
    } catch {
      continue
    }
    const fm = parseFrontmatter(text)
    const name = fm.name || entry.name
    if (!fm.description) continue
    found.push({ name, description: fm.description })
  }
  return found
}

export function scanRoster(dirs: string[], maxRoster = DEFAULTS.maxRoster): SkillEntry[] {
  const byName = new Map<string, SkillEntry>()
  for (const dir of dirs) {
    for (const entry of scanSkillDir(dir)) {
      if (!byName.has(entry.name)) byName.set(entry.name, entry)
    }
  }
  const roster = [...byName.values()]
  roster.length = Math.min(roster.length, maxRoster)
  return roster
}

export class JevSuggester {
  private client: TypeSafeClient | null
  private opts: {
    model: string
    timeoutMs: number
    gateThreshold: number
    fitsThreshold: number
    shortlistSize: number
  }

  constructor(config: JevConfig = {}) {
    this.opts = {
      model: config.model ?? process.env.TYPESAFE_MODEL ?? DEFAULTS.model,
      timeoutMs:
        config.timeoutMs ?? (Number(process.env.JEV_TIMEOUT_MS) || DEFAULTS.timeoutMs),
      gateThreshold:
        config.gateThreshold ?? (Number(process.env.JEV_GATE_THRESHOLD) || DEFAULTS.gateThreshold),
      fitsThreshold:
        config.fitsThreshold ?? (Number(process.env.JEV_FITS_THRESHOLD) || DEFAULTS.fitsThreshold),
      shortlistSize: config.shortlistSize ?? DEFAULTS.shortlistSize,
    }
    const apiKey = config.apiKey || process.env.TYPESAFE_API_KEY
    if (!apiKey) {
      this.client = null
      return
    }
    // baseURL intentionally has no default: the SDK resolves
    // config.baseURL ?? TYPESAFE_BASE_URL ?? https://api.typesafe.ai itself.
    const baseURL = config.baseURL
    try {
      this.client = new TypeSafeClient({
        timeout: this.opts.timeoutMs,
        ...(baseURL !== undefined ? { baseURL } : {}),
        apiKey,
      })
    } catch {
      this.client = null
    }
  }

  get enabled(): boolean {
    return this.client !== null
  }

  get timeoutMs(): number {
    return this.opts.timeoutMs
  }

  async suggest(request: string, roster: SkillEntry[]): Promise<SkillEntry[]> {
    if (!this.client || roster.length === 0) return []
    try {
      const wide = await this.rankWide(request, roster)
      if (wide.gate < this.opts.gateThreshold) return []
      const shortlist = wide.ranked.slice(0, this.opts.shortlistSize)
      if (shortlist.length === 0) return []
      return await this.rerank(request, shortlist)
    } catch {
      return []
    }
  }

  private async rankWide(
    request: string,
    roster: SkillEntry[],
  ): Promise<{ ranked: SkillEntry[]; gate: number }> {
    const client = this.client!
    const criteria: Record<string, string> = {}
    for (const skill of roster) {
      criteria[skill.name] = skill.description.slice(0, WIDE_DESC_CHARS)
    }
    const questions: Record<string, ReturnType<typeof choice> | ReturnType<typeof noul>> = {
      which: choice(WIDE_INSTRUCTIONS, criteria),
    }
    for (const [key, text] of Object.entries(GATE_QUESTIONS)) {
      questions[`gate::${key}`] = noul(text)
    }
    const response = await client.systemOne({
      state: { request },
      questions,
      model: this.opts.model,
    })
    const probabilities = (response.answers.which as { probabilities: Record<string, number> })
      .probabilities
    const ranked = Object.entries(probabilities)
      .sort((a, b) => b[1] - a[1])
      .filter(([name]) => criteria[name] !== undefined)
      .map(([name]) => roster.find((s) => s.name === name)!)
    const values: Record<string, number> = {}
    for (const key of Object.keys(GATE_QUESTIONS)) {
      const answer = response.answers[`gate::${key}`] as { noul: number } | undefined
      if (answer) values[key] = answer.noul
    }
    const oriented = Object.entries(values).map(([key, v]) => (INVERTED.has(key) ? 1 - v : v))
    const gate = oriented.length > 0 ? oriented.reduce((a, b) => a + b, 0) / oriented.length : 0
    return { ranked, gate }
  }

  private async rerank(request: string, shortlist: SkillEntry[]): Promise<SkillEntry[]> {
    const client = this.client!
    const criteria: Record<string, string> = {}
    for (const skill of shortlist) {
      criteria[skill.name] = skill.description.slice(0, RERANK_DESC_CHARS)
    }
    const questions: Record<string, ReturnType<typeof choice> | ReturnType<typeof noul>> = {
      which: choice(RERANK_INSTRUCTIONS, criteria),
    }
    for (const skill of shortlist) {
      questions[`fits::${skill.name}`] = noul(
        `Does the skill '${skill.name}' do the specific thing the user's request asks for? It is described as: ${skill.description.slice(0, RERANK_DESC_CHARS)}`,
      )
    }
    const response = await client.systemOne({
      state: { request },
      questions,
      model: this.opts.model,
    })
    const winner = (response.answers.which as { choice: string }).choice
    const fits: number[] = []
    for (const skill of shortlist) {
      const answer = response.answers[`fits::${skill.name}`] as { noul: number } | undefined
      if (answer) fits.push(answer.noul)
    }
    const bestFit = fits.length > 0 ? Math.max(...fits) : 1
    if (bestFit < this.opts.fitsThreshold) return []
    const winnerEntry = shortlist.find((s) => s.name === winner)
    return winnerEntry ? [winnerEntry] : []
  }
}

export function suggestionBlock(names: string[]): string {
  const body =
    names.length > 0
      ? `Relevant to the current request: ${names.join(", ")}. Ignore this if it does not fit what the user actually asked for.`
      : "No skill in the roster appears relevant to this request."
  return `<skill_relevance>\n${body}\n</skill_relevance>`
}
