import { expect, mock, test } from 'claude-code/testing'

const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } } as const

const PANE = {
  plugin: 'pilot-scorecard',
  component: 'Pane',
  requestId: 'pilot',
  props: {
    title: 'Pilot',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const DIMS = [
    { key: 'brief', name: 'Brief quality', score: 80, baseline: 70, causes: [] },
    { key: 'verify', name: 'Verification', score: 30, baseline: 50, causes: ['edits to files never read: 0.40'] },
    { key: 'context', name: 'Context hygiene', score: 60, baseline: null, causes: [] },
    { key: 'delegate', name: 'Delegation', score: null, baseline: null, causes: [] },
    { key: 'flow', name: 'Flow', score: 90, baseline: 90, causes: [] },
  ]
const WIN = { sessions: 7, weakest: 'verify', dims: DIMS }
const REPORT = {
  generatedAt: '2026-10-28T06:00:00+00:00',
  windows: { '7': WIN, '14': WIN, '30': WIN, '60': WIN },
  daily: Array.from({ length: 120 }, (_, i) => ({
    day: `d${i}`,
    scores: { brief: 80, verify: i < 113 ? 50 : 30, context: 60, delegate: null, flow: 90 },
  })),
}

test('/pilot scores through the analyzer and the pane shows the weakest dimension', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  on('command.register', () => ({ value: { command: 'pilot' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: JSON.stringify(REPORT), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ran = await $.command.run({ ...RUN, command: 'pilot', args: '' })
  expect(ran.text).toBe('pilot: scored 7 sessions. Weakest: verify.')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Weakest: Verification/ }))?.text).toBe('Weakest: Verification')
  expect((await ui.find({ type: 'Text', text: /never read/ }))?.text).toContain('0.40')
  expect((await ui.find({ type: 'Text', text: /^\s*\+10$/ }))?.text).toContain('+10')
  expect((await ui.find({ type: 'Text', text: /now$/ }))?.text).toMatch(/[▁-█]{7} now/)
  await ui.unmount()

  const started = await $.command.run({ ...RUN, command: 'pilot', args: 'experiment' })
  expect(started.text).toContain('experiment on Verification (score 30)')

  const win = await $.command.run({ ...RUN, command: 'pilot', args: 'window 30' })
  expect(win.text).toBe('pilot: showing last 30 days vs the 30 before.')
  expect((await $.command.run({ ...RUN, command: 'pilot', args: 'window 9' })).text).toContain('one of 7, 14, 30, 60')
})
