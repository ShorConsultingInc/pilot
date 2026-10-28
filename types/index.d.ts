export type DimKey = 'brief' | 'verify' | 'context' | 'delegate' | 'flow'

export type Dim = {
  key: DimKey
  name: string
  score: number | null
  baseline: number | null
  causes: string[]
}

export type Window = { sessions: number; weakest: DimKey | null; dims: Dim[] }

export type Report = {
  generatedAt: string
  windows: Record<string, Window>
  daily: { day: string; scores: Record<DimKey, number | null> }[]
}

export type Experiment = {
  dim: DimKey
  rule: string
  startedAt: string
  baseline: number | null
}

/** One published engineer (or "team"), as scores/<login>.json in the scores repo holds it. */
export type Peer = {
  login: string
  windows: Record<string, Partial<Record<DimKey, { score: number | null; baseline: number | null }>>>
}

declare module 'claude-code' {
  interface PluginState {
    'pilot-scorecard': {
      report: Shaped<Report | null>
      experiment: Shaped<Experiment | null>
      window: Shaped<number>
      peer: Shaped<Peer | null>
    }
  }
}
