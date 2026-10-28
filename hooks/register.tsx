import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Dim, DimKey, Experiment, Peer, Report } from '../types'

const PANE = 'pilot'
const WINDOWS = [7, 14, 30, 60]
const report = atom({ plugin: 'pilot', key: 'report' } as const, null, { shape: 'report-2' })
const experiment = atom({ plugin: 'pilot', key: 'experiment' } as const, null, {
  shape: 'experiment-1',
})
const window = atom({ plugin: 'pilot', key: 'window' } as const, 7, { shape: 'window-1' })
const peer = atom({ plugin: 'pilot', key: 'peer' } as const, null, { shape: 'peer-1' })

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

    if (verb === 'experiment' && arg !== 'stop') {
      const r = (await read($, report)) ?? (await refresh($))
      const win = r?.windows['7']
      if (!win?.weakest) return { text: 'pilot: no scores yet, run /pilot refresh first.' }
      const dim = win.dims.find(d => d.key === win.weakest)!
      const exp: Experiment = {
        dim: dim.key,
        rule: RULES[dim.key],
        startedAt: new Date(await $.clock.now()).toISOString(),
        baseline: dim.score,
      }
      await update($, experiment, () => exp)
      await $.store.set('experiment', exp)
      return { text: `pilot: experiment on ${dim.name} (score ${dim.score}). Rule for the week: ${exp.rule}` }
    }

    if (verb === 'experiment') {
      const exp = await read($, experiment)
      if (!exp) return { text: 'pilot: no experiment running.' }
      const r = await refresh($, exp.startedAt)
      const dim = r?.windows.since?.dims.find(d => d.key === exp.dim)
      await update($, experiment, () => null)
      await $.store.delete('experiment')
      return {
        text: `pilot: ${dim?.name ?? exp.dim} went ${exp.baseline} → ${dim?.score ?? 'n/a'} (${delta(dim?.score ?? null, exp.baseline) || 'n/a'}) since ${exp.startedAt.slice(0, 10)}. Keep the rule if it helped: add it to your CLAUDE.md.`,
      }
    }

    if (verb === 'share') {
      const r = (await read($, report)) ?? (await refresh($))
      if (!r) return { text: 'pilot: nothing to share yet.' }
      const path = `${$.plugin.root}/../pilot-share.json`
      await $.fs.write(path, JSON.stringify(sharePayload(r), null, 1))
      const ran = await $.process.run(
        ['gh', 'issue', 'create', '--repo', scoresRepo, '--title', 'pilot scores', '--body-file', path],
        { timeoutMs: 60_000 },
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
      const url = `https://raw.githubusercontent.com/${scoresRepo}/main/scores/${arg}.json`
      const res = await $.http.fetch(url)
      if (!res.ok) return { text: `pilot: no published scores for "${arg}" in ${scoresRepo} (HTTP ${res.status}).` }
      const p = JSON.parse(res.text) as Peer
      await update($, peer, () => p)
      return { text: `pilot: comparing with ${p.login}.` }
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
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, report)
    const exp = await read($, experiment)
    const w = await read($, window)
    const p = await read($, peer)
    const win = r?.windows[String(w)]
    if (!r || !win) {
      return (
        <Box flexDirection="column">
          <Text dimColor>No scorecard yet.</Text>
          <Button key="refresh" label="Score my sessions" onPress={() => refresh($)} />
        </Box>
      )
    }
    const cols = Math.max(20, (e.props.bodyColumns ?? 60) - 2)
    const sparkCols = Math.min(w, Math.max(7, cols - 30))
    const cur = r.daily.slice(-sparkCols)
    const prior = r.daily.slice(-2 * sparkCols, -sparkCols)
    const weakest = win.dims.find(d => d.key === win.weakest)
    const peerScore = (d: Dim) => p?.windows[String(w)]?.[d.key]?.score ?? null

    return (
      <Box flexDirection="column">
        <Box>
          {WINDOWS.map(n => (
            <Button key={`w${n}`} label={n === w ? `[${n}d]` : `${n}d`} plain onPress={() => update($, window, () => n)} />
          ))}
          <Text dimColor>
            {'  '}{win.sessions} sessions · vs prior {w}d · {r.generatedAt.slice(0, 16).replace('T', ' ')}
          </Text>
        </Box>
        {win.dims.map(d => (
          <Box key={d.key} flexDirection="column">
            <Text mono>
              {d.name.padEnd(16)} {bar(d.score)} {delta(d.score, d.baseline).padStart(4)}
              {p ? `  ${p.login}: ${peerScore(d) ?? 'n/a'} ${delta(d.score, peerScore(d))}` : ''}
            </Text>
            <Text mono dimColor>
              {' '.repeat(17)}{spark(cur.map(x => x.scores[d.key]))} now
            </Text>
            <Text mono dimColor>
              {' '.repeat(17)}{spark(prior.map(x => x.scores[d.key]))} prior
            </Text>
          </Box>
        ))}
        {weakest && weakest.causes.length > 0 && (
          <Box flexDirection="column">
            <Text bold>Weakest: {weakest.name}</Text>
            {weakest.causes.map(c => (
              <Text key={c} dimColor>
                {'  '}{c}
              </Text>
            ))}
          </Box>
        )}
        {exp ? (
          <Box flexDirection="column">
            <Text>
              Experiment since {exp.startedAt.slice(0, 10)}: {exp.rule}
            </Text>
            <Button key="stop" label="Stop and measure" onPress={() => $.command.run({ command: 'pilot', args: 'experiment stop' })} />
          </Box>
        ) : (
          <Box>
            <Button key="refresh" label="Refresh" onPress={() => refresh($)} />
            <Button key="exp" label="Start experiment" onPress={() => $.command.run({ command: 'pilot', args: 'experiment' })} />
            <Button key="team" label={p ? 'Clear compare' : 'Compare: team'} onPress={() => $.command.run({ command: 'pilot', args: p ? 'compare' : 'compare team' })} />
          </Box>
        )}
      </Box>
    )
  })
}
