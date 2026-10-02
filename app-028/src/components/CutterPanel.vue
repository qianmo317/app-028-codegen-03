<script setup lang="ts">
/**
 * 设备判定面板：按当前选中的设备显示这个排样能不能裁，
 * 并列出适合的机器清单；不适合的写清原因与改纸 / 换设备建议。
 * 排样预览页与裁切步骤页共用，手工微调后传入的 sheets 一变就自动重新判定。
 */
import { computed } from 'vue'
import {
  allCutters,
  allPapers,
  allSizes,
  selectCutter,
  selectedCutterId,
} from '../store'
import { groupsFromTask } from '../logic/library'
import {
  FAIL_LABEL,
  judgeAllCutters,
  judgePaperOnCutter,
  suggestCutters,
  suggestPapers,
  type CutterVerdict,
  type PaperSuggestion,
} from '../logic/cutter'
import type { Paper, Sheet, Task } from '../logic/types'

const props = defineProps<{
  task: Task
  paper: Paper
  sheets: Sheet[]
  /** detail = 展开全部机器逐张判定；compact = 只显示当前设备结论 */
  variant?: 'detail' | 'compact'
}>()

const opts = computed(() => ({
  paperW: props.paper.wMm,
  paperH: props.paper.hMm,
  marginMm: props.paper.marginMm,
  safeEdgeMm: props.task.safeEdgeMm,
  gapMm: props.task.gapMm,
  kerfMm: props.task.kerfMm,
  allowRotate: props.task.allowRotate,
}))

/** 逐台判定（手工微调 / 换机器都会触发重算） */
const verdicts = computed<CutterVerdict[]>(() =>
  judgeAllCutters(props.sheets, props.paper, opts.value, allCutters.value),
)

const current = computed<CutterVerdict | undefined>(() =>
  verdicts.value.find((v) => v.cutter.id === selectedCutterId.value),
)

const currentFailures = computed(
  () =>
    Array.from(
      new Set(current.value?.sheets.flatMap((s) => s.failures) ?? []),
    ) as (keyof typeof FAIL_LABEL)[],
)

const suitableMachines = computed(() => suggestCutters(verdicts.value, selectedCutterId.value))

/** 改纸建议：拿相纸库候选真实重排后再让这台设备判一次，只推荐实测可行的 */
const paperSuggestions = computed<PaperSuggestion[]>(() => {
  const cv = current.value
  if (!cv || cv.ok) return []
  const failures = currentFailures.value
  const groups = groupsFromTask(props.task, allSizes.value)
  if (!groups.length) return []
  const candidates = suggestPapers(
    props.paper,
    cv.cutter,
    failures,
    allPapers.value.filter((p) => p.id !== 'proll152'),
    4,
  )
  const out: PaperSuggestion[] = []
  for (const cand of candidates) {
    const v = judgePaperOnCutter(groups, opts.value, cand.paper, cv.cutter)
    if (v?.ok) {
      out.push({
        paper: cand.paper,
        feasible: true,
        reason: `已在「${cand.paper.name}」上重排实测：${v.sheets.length} 张纸，本设备逐张可裁`,
      })
    }
  }
  return out.slice(0, 3)
})

function kindLabel(kind: string): string {
  return kind === 'trimmer' ? '裁刀' : kind === 'guillotine' ? '铡刀' : '电动裁切机'
}

function onSelect(id: string) {
  selectCutter(id)
}
</script>

<template>
  <div class="stack">
    <label class="field">
      按这台设备判定
      <select :value="selectedCutterId" @change="onSelect(($event.target as HTMLSelectElement).value)">
        <option v-for="c in allCutters" :key="c.id" :value="c.id">
          {{ c.name }}（{{ kindLabel(c.kind) }}）
        </option>
      </select>
    </label>

    <div v-if="current" class="note" :class="current.ok ? 'ok' : 'danger'">
      <template v-if="current.ok">
        <strong>✓ 这台机器能裁：</strong>
        「{{ current.cutter.name }}」逐张判定通过。
        <span v-if="current.stackAdvice">{{ current.stackAdvice }}。</span>
      </template>
      <template v-else>
        <strong>✗ 这台机器裁不了这单：</strong>
        {{ currentFailures.map((f) => FAIL_LABEL[f]).join(' + ') }}。裁之前必须换设备或改纸，别裁到一半才发现。
      </template>
    </div>

    <!-- 当前设备：逐张、逐刀判定依据 -->
    <div v-if="current" class="stack">
      <div
        v-for="s in current.sheets"
        :key="s.sheetIndex"
        class="verdict-sheet"
        :class="{ bad: !s.ok }"
      >
        <div class="row" style="justify-content: space-between">
          <strong>第 {{ s.sheetIndex + 1 }} 张相纸</strong>
          <span class="badge" :class="s.ok ? 'ok' : 'danger'">
            {{ s.ok ? '可裁' : s.failures.map((f) => FAIL_LABEL[f]).join(' / ') }}
          </span>
        </div>
        <div class="mini-stats">
          <span>共切 <b>{{ s.cutCount }}</b> 刀</span>
          <span>最长一刀 <b>{{ s.longestCutMm.toFixed(1) }}</b>mm</span>
          <span>最窄成品条 <b>{{ s.narrowestStripMm ? s.narrowestStripMm.toFixed(1) : '—' }}</b>mm</span>
          <span>设备最小条宽 {{ current.cutter.minStripMm }}mm</span>
          <span>单张刀数上限 {{ current.cutter.maxCutsPerSheet === 0 ? '不限' : current.cutter.maxCutsPerSheet }}</span>
        </div>
        <ul v-if="!s.ok || variant === 'detail'" class="verdict-details">
          <li v-for="(d, i) in s.details" :key="i">{{ d }}</li>
        </ul>
        <details v-if="s.measures.length && variant === 'detail'">
          <summary>逐刀测量（{{ s.measures.length }} 刀）</summary>
          <table class="data">
            <thead>
              <tr>
                <th class="num">刀序</th>
                <th>方向</th>
                <th class="num">刀长 mm</th>
                <th class="num">夹出窄条 mm</th>
                <th>类型</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="m in s.measures" :key="m.index">
                <td class="num">{{ m.index + 1 }}</td>
                <td>{{ m.axis === 'v' ? '竖切' : '横切' }}</td>
                <td class="num">{{ m.lengthMm.toFixed(1) }}</td>
                <td
                  class="num"
                  :class="{
                    over: m.internal && m.stripMm + 1e-6 < current.cutter.minStripMm,
                    mute: !m.internal,
                  }"
                >
                  {{ m.stripMm.toFixed(1) }}
                </td>
                <td>{{ m.internal ? '共边刀（成品条）' : '修边刀（纸边废料）' }}</td>
              </tr>
            </tbody>
          </table>
        </details>
      </div>
    </div>

    <!-- 建议：换设备 -->
    <div v-if="current && !current.ok" class="stack">
      <div v-if="suitableMachines.length" class="note ok">
        <strong>换设备建议：</strong>
        本方案适合
        <button
          v-for="m in suitableMachines"
          :key="m.id"
          class="btn small"
          style="margin: 0 4px"
          @click="onSelect(m.id)"
        >
          {{ m.name }}
        </button>
        （点名字直接切换）
      </div>
      <div v-else class="note warn">
        设备库里没有一台能整单裁下——下面按改纸建议重排，或先到「设备档案」登记新设备。
      </div>

      <!-- 建议：改纸（真实重排实测后才推荐） -->
      <div v-if="paperSuggestions.length" class="note">
        <strong>改纸建议：</strong>
        <ul style="margin: 4px 0 0; padding-left: 18px">
          <li v-for="ps in paperSuggestions" :key="ps.paper.id">
            换 {{ ps.paper.name }} {{ ps.paper.wMm }}×{{ ps.paper.hMm }}mm：{{ ps.reason }}
          </li>
        </ul>
      </div>

      <!-- 条太窄：换纸解决不了，给出真正有效的处置 -->
      <div v-if="currentFailures.includes('strip')" class="note warn">
        <strong>有条太窄怎么办：</strong>
        条宽由照片本身的尺寸决定，换纸也不会变宽——请改选「最小条宽」更小的设备
        （如滚轮裁刀），或在「新建任务」里加大相邻照片间距 gapMm 后重新排样；
        实在不行只能先大片裁开、再用窄条刀二次修边。
      </div>

      <!-- 刀口太宽：调刀宽补偿 / 隙距 -->
      <div v-if="currentFailures.includes('blade')" class="note warn">
        <strong>刀口太宽怎么办：</strong>
        回「新建任务」把刀宽补偿 kerfMm 与间距 gapMm 调到合计 ≥
        {{ current.cutter.bladeMm }}mm 后重新排样（照片仍为标称尺寸，只是照片间距变大），
        或换刀口更窄的设备。
      </div>
    </div>

    <!-- 全部机器清单 -->
    <details :open="variant === 'detail'">
      <summary>适合的机器清单（{{ verdicts.filter((v) => v.ok).length }}/{{ verdicts.length }} 台可裁）</summary>
      <table class="data" style="margin-top: 6px">
        <thead>
          <tr>
            <th>设备</th>
            <th class="num">幅面 mm</th>
            <th class="num">最小条宽</th>
            <th class="num">层数</th>
            <th class="num">刀数上限</th>
            <th>判定</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="v in verdicts"
            :key="v.cutter.id"
            :class="{ pick: v.cutter.id === selectedCutterId }"
            style="cursor: pointer"
            @click="onSelect(v.cutter.id)"
          >
            <td>{{ v.cutter.name }}</td>
            <td class="num">{{ v.cutter.maxWmm }}×{{ v.cutter.maxHmm }}</td>
            <td class="num">{{ v.cutter.minStripMm }}mm</td>
            <td class="num">{{ v.cutter.maxLayers }}</td>
            <td class="num">{{ v.cutter.maxCutsPerSheet === 0 ? '不限' : v.cutter.maxCutsPerSheet }}</td>
            <td>
              <span v-if="v.ok" class="badge ok">适合</span>
              <span v-else class="badge danger">
                {{ Array.from(new Set(v.sheets.flatMap((s) => s.failures))).map((f) => FAIL_LABEL[f]).join(' / ') }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </details>
  </div>
</template>

<style scoped>
.verdict-sheet {
  border: 1px solid var(--line);
  border-radius: 6px;
  padding: 8px 10px;
  background: var(--ok-soft);
}
.verdict-sheet.bad {
  background: var(--danger-soft);
  border-color: #f0c6c6;
}
.mini-stats {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--ink-2);
  margin-top: 4px;
}
.mini-stats b {
  font-family: var(--font-mono);
  color: var(--ink);
}
.verdict-details {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12.5px;
  color: var(--ink-2);
}
tr.pick td {
  background: var(--brand-soft);
}
td.num.over {
  color: var(--danger);
  font-weight: 700;
}
td.num.mute {
  color: var(--ink-3);
}
</style>
