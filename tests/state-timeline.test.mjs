import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseScenes } from '../lib/beat-structure.js'
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

test('显式文字赋值显示计划值并随章节继承', () => {
  const scenes = parseScenes(`### 场景 break-chain：断链
- 状态对象：chain
- 状态变化：锁链：崩成两截
### 场景 melt-fragments：熔化残段
- 状态对象：chain、fragment
- 状态变化：fragment: 被熔掉；chain：仅剩链柄`)
  const rows = stateTimeline([{ id: '1', status: 'matched', section: { scenes } }, chapter('2')])
  const [chain, fragment] = rows['1']
  assert.equal(chain.changes[0].name, '锁链')
  assert.equal(chain.changes[0].value, '崩成两截')
  assert.equal(chain.value, '仅剩链柄')
  assert.equal(fragment.value, '被熔掉')
  assert.equal(fragment.before, null)
  assert.equal(fragment.warning, '')
  assert.equal(rows['2'][1].value, '被熔掉')
  assert.equal(rows['2'][1].inherited, true)
  assert.equal(rows['2'][1].scene, 'melt-fragments')
})

test('数字迁移优先，结果中的文字及空赋值仍待核对', () => {
  const scenes = parseScenes(`### 场景 update：更新状态
- 状态对象：guoli、chain
- 状态变化：guoli 3090 → 3000；chain：崩成两截
### 场景 empty：空赋值
- 状态对象：fragment
- 状态变化：残段：
### 场景 result-only：仅填写结果
- 状态对象：door
- 结果：门：已关闭`)
  const rows = stateTimeline([chapter('1', '国力 3210 → 3090'), { id: '2', status: 'matched', section: { scenes } }])
  assert.deepEqual(rows['2'].map(item => item.value), ['3000', null, null, null])
  assert.equal(rows['2'][0].before, '3090')
  assert.equal(rows['2'][0].warning, '')
})
