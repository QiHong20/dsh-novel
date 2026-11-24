import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stateTimeline } from '../lib/state-timeline.js'
const chapter = (id, result) => ({ id, status: 'matched', section: { scenes: result === undefined ? [] : [{ id: `s${id}`, fields: { 状态对象: 'guoli', 结果: result } }] } })
test('planned transitions inherit without mutating earlier snapshots and flag gaps', () => {
  const rows = stateTimeline([chapter('1', '国力 3210 → 3090（-120）'), chapter('2'), chapter('3', '国力 3000 → 2870')])
  assert.equal(rows['1'][0].value, '3090')
  assert.equal(rows['2'][0].value, '3090')
  assert.equal(rows['2'][0].inherited, true)
  assert.match(rows['3'][0].warning, /不一致/)
})
test('unresolved bindings and missing outlines do not silently inherit a known value', () => {
  const rows = stateTimeline([chapter('1', '国力 3210 → 3090'), chapter('2', '将来上涨'), { id: '3', status: 'missing' }, chapter('4')])
  assert.equal(rows['2'][0].value, null)
  assert.deepEqual(rows['4'], [])
})
