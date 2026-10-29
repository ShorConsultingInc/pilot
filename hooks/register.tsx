import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Dim, DimKey, Experiment, Peer, Report } from '../types'

const PANE = 'pilot'
const WINDOWS = [7, 14, 30, 60]
const report = atom({ plugin: 'pilot-scorecard', key: 'report' } as const, null, { shape: 'report-2' })
const experiment = atom({ plugin: 'pilot-scorecard', key: 'experiment' } as const, null, {
  shape: 'experiment-1',
})
const window = atom({ plugin: 'pilot-scorecard', key: 'window' } as const, 7, { shape: 'window-1' })
const peer = atom({ plugin: 'pilot-scorecard', key: 'peer' } as const, null, { shape: 'peer-1' })

// One rule per dimension: the smallest process change that moves that score.
const RULES: Record<DimKey, string> = {
  brief: 'Every task prompt names what done looks like (12+ words, one done criterion).',
  verify: 'Run the tests before every commit, and read a file before editing it.',
  context: 'Read with offset/limit and pipe Bash output through head or grep.',
  delegate: 'Any task over ~60 tool calls or 5+ files gets plan mode or a subagent.',
  flow: 'When Claude heads the wrong way, interrupt with a correction, not a restart.',
}

async function refresh($: EngineInterface, since?: string): Promise<Report | null> {
  const argv = ['python3', `${$.plugin.root}/scripts/pilot.py`]
  if (since) argv.push('--since', since)
  const ran = await $.process.run(argv, { timeoutMs: 600_000 })
  if (ran.exitCode !== 0) {
    $.ui.toast(`pilot: analyzer failed: ${ran.stderr.slice(0, 120)}`)
    return null
  }
  const next = JSON.parse(ran.stdout) as Report
  await update($, report, () => next)
  await $.store.set('report', next)
  return next
}

function bar(score: number | null): string {
  if (score === null) return '░░░░░░░░░░ n/a'
  const full = Math.round(score / 10)
  return '█'.repeat(full) + '░'.repeat(10 - full) + ` ${String(score).padStart(3)}`
}

const BLOCKS = '▁▂▃▄▅▆▇█'
function spark(points: (number | null)[]): string {
  return points.map(p => (p === null ? ' ' : BLOCKS[Math.min(7, Math.floor(p / 12.5))])).join('')
}

function delta(a: number | null, b: number | null): string {
  if (a === null || b === null) return ''
  const d = a - b
  return `${d >= 0 ? '+' : ''}${d}`
}

// Scores only: no prompts, paths, projects or token counts leave the machine.
function sharePayload(r: Report) {
  const windows: Record<string, { dims: { key: DimKey; score: number | null; baseline: number | null }[] }> = {}
  for (const w of WINDOWS) {
    const win = r.windows[String(w)]
    if (win) windows[String(w)] = { dims: win.dims.map(d => ({ key: d.key, score: d.score, baseline: d.baseline })) }
  }
  return { version: 1, generatedAt: r.generatedAt, windows }
}

async function startExperiment($: EngineInterface): Promise<string> {
  const r = (await read($, report)) ?? (await refresh($))
  const win = r?.windows['7']
  if (!win?.weakest) return 'pilot: no scores yet, run /pilot refresh first.'
  const dim = win.dims.find(d => d.key === win.weakest)!
  const exp: Experiment = {
    dim: dim.key,
    rule: RULES[dim.key],
    startedAt: new Date(await $.clock.now()).toISOString(),
    baseline: dim.score,
  }
  await update($, experiment, () => exp)
  await $.store.set('experiment', exp)
  return `pilot: experiment on ${dim.name} (score ${dim.score}). Rule for the week: ${exp.rule}`
}

async function stopExperiment($: EngineInterface): Promise<string> {
  const exp = await read($, experiment)
  if (!exp) return 'pilot: no experiment running.'
  const r = await refresh($, exp.startedAt)
  const dim = r?.windows.since?.dims.find(d => d.key === exp.dim)
  await update($, experiment, () => null)
  await $.store.delete('experiment')
  return `pilot: ${dim?.name ?? exp.dim} went ${exp.baseline} → ${dim?.score ?? 'n/a'} (${delta(dim?.score ?? null, exp.baseline) || 'n/a'}) since ${exp.startedAt.slice(0, 10)}. Keep the rule if it helped: add it to your CLAUDE.md.`
}

// Reads one published scores file from the scores repo on raw.githubusercontent.com; nothing else is contacted.
async function compare($: EngineInterface, scoresRepo: string, login: string): Promise<string> {
  if (!/^[A-Za-z0-9-]{1,39}$/.test(login) || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(scoresRepo)) {
    return 'pilot: login and scoresRepo must be plain GitHub names.'
  }
  const res = await $.http.fetch(`https://raw.githubusercontent.com/${scoresRepo}/main/scores/${login}.json`)
  if (!res.ok) return `pilot: no published scores for "${login}" in ${scoresRepo} (HTTP ${res.status}).`
  const p = JSON.parse(res.text) as Peer
  await update($, peer, () => p)
  return `pilot: comparing with ${p.login}.`
}

function tone(score: number | null): 'success' | 'warning' | 'error' | 'subtle' {
  if (score === null) return 'subtle'
  return score >= 70 ? 'success' : score >= 40 ? 'warning' : 'error'
}

const COLORS: Record<DimKey, string> = { brief: '#4f8ef7', verify: '#f59e0b', context: '#10b981', delegate: '#a855f7', flow: '#ef4444' }
const NAMES: Record<DimKey, string> = { brief: 'Brief', verify: 'Verify', context: 'Context', delegate: 'Delegate', flow: 'Flow' }

// Line chart: the window's daily scores solid, the prior window dashed, one line per dimension.
// The root carries width and height: the desktop draws nothing of a pane whose Svg has only a viewBox.
function chart(cur: Report['daily'], prior: Report['daily'], days: number): string {
  const W = 620, H = 190, L = 28, R = 8, T = 10, B = 34
  const x = (i: number) => L + (i * (W - L - R)) / Math.max(1, days - 1)
  const y = (v: number) => T + ((100 - v) * (H - T - B)) / 100
  const path = (pts: Report['daily'], k: DimKey) =>
    pts.map((d, i) => (d.scores[k] === null ? null : `${x(i).toFixed(1)},${y(d.scores[k]!).toFixed(1)}`)).filter(Boolean).map((s, i) => (i ? 'L' : 'M') + s).join(' ')
  const grid = [0, 25, 50, 75, 100].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="#888" stroke-opacity=".25"/><text x="${L - 4}" y="${y(v) + 3}" font-size="9" fill="#888" text-anchor="end">${v}</text>`).join('')
  const lines = (Object.keys(COLORS) as DimKey[]).map(k =>
    `<path d="${path(prior, k)}" fill="none" stroke="${COLORS[k]}" stroke-width="1.2" stroke-dasharray="3 3" stroke-opacity=".55"/>` +
    `<path d="${path(cur, k)}" fill="none" stroke="${COLORS[k]}" stroke-width="2"/>`).join('')
  const legend = (Object.keys(COLORS) as DimKey[]).map((k, i) =>
    `<rect x="${L + i * 110}" y="${H - 18}" width="10" height="3" fill="${COLORS[k]}"/><text x="${L + i * 110 + 14}" y="${H - 14}" font-size="10" fill="#888">${NAMES[k]}</text>`).join('')
  const note = `<text x="${W - R}" y="${H - 14}" font-size="9" fill="#888" text-anchor="end">solid: last ${days}d · dashed: the ${days} before</text>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${grid}${lines}${legend}${note}</svg>`
}

export const register: Register = (on, options) => {
  const scoresRepo = typeof options.scoresRepo === 'string' && options.scoresRepo ? options.scoresRepo : 'ShorConsultingInc/pilot-scores'
  let testedThisSession = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pilot',
      description: 'Your Claude Code scorecard',
      argumentHint: '[refresh | window 7|14|30|60 | experiment [stop] | share | compare <login|team>]',
    })
    const stored = (await $.store.get('report')) as Report | undefined
    if (stored?.windows) await update($, report, () => stored)
    const exp = (await $.store.get('experiment')) as Experiment | undefined
    if (exp) await update($, experiment, () => exp)
    return next(e)
  })

  on('command.run', { command: 'pilot' }, async ($, e) => {
    const [verb, arg] = e.args.trim().split(/\s+/)
    await $.ui.open({ id: PANE, title: 'Pilot' })

    if (verb === 'window') {
      const w = Number(arg)
      if (!WINDOWS.includes(w)) return { text: `pilot: window is one of ${WINDOWS.join(', ')} days.` }
      await update($, window, () => w)
      return { text: `pilot: showing last ${w} days vs the ${w} before.` }
    }

    if (verb === 'experiment') return { text: arg === 'stop' ? await stopExperiment($) : await startExperiment($) }

    if (verb === 'share') {
      const r = (await read($, report)) ?? (await refresh($))
      if (!r) return { text: 'pilot: nothing to share yet.' }
      // The payload goes to gh on stdin; no file is written.
      const ran = await $.process.run(
        ['gh', 'issue', 'create', '--repo', scoresRepo, '--title', 'pilot scores', '--body-file', '-'],
        { stdin: JSON.stringify(sharePayload(r), null, 1), timeoutMs: 60_000 },
      )
      return ran.exitCode === 0
        ? { text: `pilot: scores sent to ${scoresRepo} (${ran.stdout.trim()}). They appear under your GitHub login once the repo's Action folds them.` }
        : { text: `pilot: share failed. Is gh signed in? ${ran.stderr.slice(0, 200)}` }
    }

    if (verb === 'compare') {
      if (!arg) {
        await update($, peer, () => null)
        return { text: 'pilot: comparison cleared.' }
      }
      return { text: await compare($, scoresRepo, arg) }
    }

    const r = verb === 'refresh' || !(await read($, report)) ? await refresh($) : await read($, report)
    const w = r?.windows[String(await read($, window))]
    return { text: r && w ? `pilot: scored ${w.sessions} sessions. Weakest: ${w.weakest}.` : 'pilot: no report.' }
  })

  // Nudges: only while an experiment runs, only for its rule, one toast each.
  on('prompt.submit', async ($, e, next) => {
    const exp = await read($, experiment)
    if (exp?.dim === 'brief' && !e.command && !e.isMeta && e.text.split(/\s+/).length < 12) {
      $.ui.toast('pilot: short brief. What does done look like?')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = e.command
    if (/\b(pytest|npm test|jest|vitest|go test|cargo test|phpunit|rspec)\b/.test(cmd)) testedThisSession = true
    const exp = await read($, experiment)
    if (exp?.dim === 'verify' && /\bgit commit\b/.test(cmd) && !testedThisSession) {
      $.ui.toast('pilot: committing with no test run this session.')
    }
    if (/\bgit commit\b/.test(cmd)) testedThisSession = false
    return next(e)
  }).catch(($, e, next) => next(e))

  on('tool.call', { tool: 'Read' }, async ($, e, next) => {
    const exp = await read($, experiment)
    if (exp?.dim === 'context' && e.limit === undefined) {
      $.ui.toast('pilot: whole-file Read. Add offset/limit?')
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : null
    const Svg = 'Svg' in els ? els.Svg : null
    const r = await read($, report)
    const exp = await read($, experiment)
    const w = await read($, window)
    const p = await read($, peer)
    const win = r?.windows[String(w)]
    if (!r || !win) {
      return (
        <Box flexDirection="column" padding={1} gap="sm">
          <Text dimColor>No scorecard yet. Scoring reads your local transcripts; nothing leaves the machine.</Text>
          <Button key="refresh" label="Score my sessions" variant="primary" onPress={() => refresh($)} />
        </Box>
      )
    }
    const cols = Math.max(40, (e.props.bodyColumns ?? 80) - 2)
    const sparkCols = Math.min(w, Math.max(7, cols - 56))
    const cur = r.daily.slice(-w)
    const prior = r.daily.slice(-2 * w, -w)
    const weakest = win.dims.find(d => d.key === win.weakest)
    const peerScore = (d: Dim) => p?.windows[String(w)]?.[d.key]?.score ?? null
    const num = (n: number | null) => (n === null ? 'n/a' : String(n)).padStart(4)

    return (
      <Box flexDirection="column" padding={1} gap="sm">
        <Box justifyContent="space-between">
          <Box gap="xs">
            {WINDOWS.map(n => (
              <Button key={`w${n}`} label={`${n}d`} variant={n === w ? 'primary' : 'secondary'} onPress={() => update($, window, () => n)} />
            ))}
          </Box>
          <Text dimColor>
            {win.sessions} sessions · last {w}d vs the {w} before · {r.generatedAt.slice(0, 16).replace('T', ' ')}
          </Text>
        </Box>

        <Box flexDirection="column">
          <Text mono dimColor>
            {'Dimension'.padEnd(16)} {'Now'.padStart(4)} {'Prior'.padStart(5)} {'Δ'.padStart(4)}
            {p ? ` ${p.login.slice(0, 8).padStart(8)} ${'Δ'.padStart(4)}` : ''}
            {'  '}now / prior
          </Text>
          {win.dims.map(d => {
            const dv = d.score !== null && d.baseline !== null ? d.score - d.baseline : null
            const pv = d.score !== null && peerScore(d) !== null ? d.score - peerScore(d)! : null
            return (
              <Box key={d.key}>
                <Text mono weight={d.key === win.weakest ? 'bold' : 'regular'}>{d.name.padEnd(16)} </Text>
                <Text mono weight="bold" color={tone(d.score)}>{num(d.score)}</Text>
                <Text mono dimColor> {num(d.baseline).padStart(5)} </Text>
                <Text mono color={dv === null ? 'subtle' : dv >= 0 ? 'success' : 'error'}>{delta(d.score, d.baseline).padStart(4) || ' n/a'}</Text>
                {p ? <Text mono> {num(peerScore(d)).padStart(8)} </Text> : null}
                {p ? <Text mono color={pv === null ? 'subtle' : pv >= 0 ? 'success' : 'error'}>{delta(d.score, peerScore(d)).padStart(4) || ' n/a'}</Text> : null}
                <Text mono color={tone(d.score)}>  {spark(cur.slice(-sparkCols).map(x => x.scores[d.key]))}</Text>
                <Text mono dimColor> / {spark(prior.slice(-sparkCols).map(x => x.scores[d.key]))}</Text>
              </Box>
            )
          })}
          <Text mono dimColor>{' '.repeat(17)}{spark(cur.slice(-sparkCols).map(x => x.scores[win.weakest ?? 'brief']))} now</Text>
        </Box>

        {Svg ? <Svg source={chart(cur, prior, w)} alt={`Daily scores for the last ${w} days, solid, against the ${w} before, dashed.`} /> : null}

        {weakest && weakest.causes.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
            <Text weight="semibold" color={tone(weakest.score)}>Weakest: {weakest.name}</Text>
            {weakest.causes.map(c => (
              <Text key={c} dimColor>
                {'  '}{c}
              </Text>
            ))}
            <Text dimColor italic>Rule that moves it: {RULES[weakest.key]}</Text>
          </Box>
        )}

        <Box gap="xs" alignItems="center" flexWrap="wrap">
          <Text dimColor>Compare:</Text>
          <Button key="team" label="Team median" variant={p?.login === 'team' ? 'primary' : 'secondary'} onPress={() => compare($, scoresRepo, 'team')} />
          {Input ? <Input key="peer" placeholder="GitHub login" submitLabel="Compare" onSubmit={v => compare($, scoresRepo, v.trim())} /> : null}
          {p ? <Button key="clear" label="Clear" onPress={() => update($, peer, () => null)} /> : null}
          {p ? <Text dimColor>vs {p.login}</Text> : null}
        </Box>

        {exp ? (
          <Box flexDirection="column" gap="xs">
            <Text>
              Experiment since {exp.startedAt.slice(0, 10)} on {exp.dim}, baseline {exp.baseline}: {exp.rule}
            </Text>
            <Box>
              <Button key="stop" label="Stop and measure" variant="primary" onPress={() => stopExperiment($)} />
            </Box>
          </Box>
        ) : (
          <Box gap="xs">
            <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
            <Button key="exp" label="Start experiment" variant="primary" onPress={() => startExperiment($)} />
            <Button key="share" label="Share scores" onPress={() => $.ui.toast('Run /pilot share to publish your scores.')} />
          </Box>
        )}
      </Box>
    )
  })
}
