<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SheetView from '../components/SheetView.vue'
import RulerScale from '../components/RulerScale.vue'
import {
  allPapers,
  allSizes,
  cutters,
  getTask,
  judgeContextOf,
  makeThumbResolver,
  photoVersion,
  runPack,
  selectCutter,
  selectedCutterId,
  sheetsOf,
} from '../store'
import { groupsFromTask, resolvePaper } from '../logic/library'
import {
  FAIL_KIND_LABEL,
  judgeAll,
  suggestPapersForCutter,
  type CutterVerdict,
  type PaperSuggestion,
  type SheetVerdict,
} from '../logic/cutter'
import type { CutStep, Task } from '../logic/types'

const route = useRoute()
const router = useRouter()

const task = computed<Task | undefined>(() => getTask(String(route.params.id)))
const paper = computed(() => (task.value ? resolvePaper(task.value, allPapers.value) : allPapers.value[0]))
const sheets = computed(() => (task.value ? sheetsOf(task.value) : []))
const activeSheet = ref(0)
const step = ref(0)
const playing = ref(false)
let timer: number | undefined

const sheet = computed(() => sheets.value[Math.min(activeSheet.value, sheets.value.length - 1)])
const steps = computed(() => sheet.value?.cutSteps ?? [])
const totalSteps = computed(() => steps.value.length)

const thumbs = computed(() => {
  void photoVersion.value
  return task.value ? makeThumbResolver(task.value, sheets.value) : () => undefined
})

const scale = computed(() => {
  const p = paper.value
  return Math.max(0.6, Math.min(3, Math.min(900 / p.wMm, 640 / p.hMm)))
})

// ---------- 设备判定（手工调过摆位后 sheets 变化，这里自动重新判定）----------
const judgeCtx = computed(() => (task.value ? judgeContextOf(task.value) : null))
const verdicts = computed<CutterVerdict[]>(() =>
  judgeCtx.value ? judgeAll(cutters.value, judgeCtx.value) : [],
)
const currentVerdict = computed<CutterVerdict | undefined>(() =>
  verdicts.value.find((v) => v.cutter.id === selectedCutterId.value) ?? verdicts.value[0],
)
const currentSheetVerdict = computed<SheetVerdict | undefined>(() =>
  currentVerdict.value?.sheetVerdicts.find((v) => v.sheetIndex === sheet.value?.index),
)
const suitableVerdicts = computed(() => verdicts.value.filter((v) => v.ok))

// 进入页面或换任务时，自动落到第一台「能裁」的机器；用户手动改选后保持其选择
let autoPickedFor = ''
watch(
  [verdicts, () => route.params.id],
  ([list, id]) => {
    const vs = list as CutterVerdict[]
    if (!vs.length || !id) return
    if (autoPickedFor === id) return
    autoPickedFor = String(id)
    const exists = vs.some((v) => v.cutter.id === selectedCutterId.value)
    const current = vs.find((v) => v.cutter.id === selectedCutterId.value)
    if (!exists || !current?.ok) {
      selectCutter(vs.find((v) => v.ok)?.cutter.id ?? vs[0].cutter.id)
    }
  },
  { immediate: true },
)

// 全部纸张上的最长一刀 / 最窄条（打印与总览用）
const jobMaxCut = computed(() => {
  const vs = currentVerdict.value?.sheetVerdicts ?? []
  if (!vs.length) return { length: 0, step: 0, sheet: 0 }
  let best = vs[0].analysis
  for (const v of vs) if (v.analysis.maxCutLength > best.maxCutLength) best = v.analysis
  return { length: best.maxCutLength, step: best.longestStep, sheet: best.sheetIndex + 1 }
})
const jobNarrowest = computed(() => {
  const vs = currentVerdict.value?.sheetVerdicts ?? []
  if (!vs.length) return { width: 0, step: 0, sheet: 0 }
  let best = vs[0].analysis
  for (const v of vs) {
    if (v.analysis.narrowestStrip > 0 && (best.narrowestStrip === 0 || v.analysis.narrowestStrip < best.narrowestStrip)) {
      best = v.analysis
    }
  }
  return { width: best.narrowestStrip, step: best.narrowestStep, sheet: best.sheetIndex + 1 }
})

// ---------- 换纸试算（同一版面换机器必须换纸时，当场给结论）----------
const paperSuggestions = ref<PaperSuggestion[]>([])
const paperSuggestOpen = ref(false)

function runPaperSuggest() {
  const t = task.value
  const c = currentVerdict.value?.cutter
  if (!t || !c) return
  const groups = groupsFromTask(t, allSizes.value)
  paperSuggestions.value = suggestPapersForCutter(
    c,
    groups,
    {
      safeEdgeMm: t.safeEdgeMm,
      gapMm: t.gapMm,
      kerfMm: t.kerfMm,
      allowRotate: t.allowRotate,
    },
    allPapers.value,
  ).filter((s) => s.paper.id !== t.paperId)
  paperSuggestOpen.value = true
}

/** 当场换纸并重新排样 */
function applyPaper(paperId: string) {
  const t = task.value
  if (!t) return
  t.paperId = paperId
  t.customPaper = undefined
  paperSuggestOpen.value = false
  const err = runPack(t)
  if (err) {
    window.alert(err)
    return
  }
  activeSheet.value = 0
  step.value = 0
}

/** 刀口太厚时，按本机刀口厚度调大刀宽补偿后当场重排 */
function fixKerfAndRepack() {
  const t = task.value
  const c = currentVerdict.value?.cutter
  if (!t || !c) return
  t.kerfMm = Math.max(t.kerfMm, c.bladeMm)
  const err = runPack(t)
  if (err) {
    window.alert(err)
    return
  }
  activeSheet.value = 0
  step.value = 0
}

function describe(s: CutStep | undefined, i: number) {
  if (!s) return ''
  if (s.axis === 'v') {
    return `第 ${i + 1} 刀：竖切 x = ${s.at.toFixed(1)}mm，从 y=${s.from.toFixed(1)} 贯通到 y=${s.to.toFixed(1)}（长 ${(s.to - s.from).toFixed(1)}mm）`
  }
  return `第 ${i + 1} 刀：横切 y = ${s.at.toFixed(1)}mm，从 x=${s.from.toFixed(1)} 贯通到 x=${s.to.toFixed(1)}（长 ${(s.to - s.from).toFixed(1)}mm）`
}

/** 每一刀相对指定机器判定结果的实测描述：刀长、夹出的窄条 */
function metricTextOf(v: SheetVerdict, i: number): string {
  const m = v.analysis.perStep[i]
  if (!m) return ''
  return `刀长 ${m.lengthMm}mm` + (m.stripMm === null ? '（仅修废边）' : `，夹条 ${m.stripMm}mm`)
}

/** 当前纸、当前机器下第 i 刀的实测描述 */
function metricText(i: number): string {
  return currentSheetVerdict.value ? metricTextOf(currentSheetVerdict.value, i) : ''
}

function isStepViolation(i: number): 'long' | 'narrow' | null {
  const v = currentSheetVerdict.value
  const c = currentVerdict.value?.cutter
  const m = v?.analysis.perStep[i]
  if (!v || !c || !m) return null
  if (m.lengthMm > Math.max(c.maxSheetWMm, c.maxSheetHMm)) return 'long'
  if (c.minStripMm > 0 && m.stripMm !== null && m.stripMm + 1e-3 < c.minStripMm) return 'narrow'
  return null
}

function togglePlay() {
  playing.value = !playing.value
  if (playing.value) {
    if (step.value >= totalSteps.value) step.value = 0
    timer = window.setInterval(() => {
      if (step.value >= totalSteps.value) {
        playing.value = false
        window.clearInterval(timer)
        timer = undefined
        return
      }
      step.value += 1
    }, 800)
  } else if (timer) {
    window.clearInterval(timer)
    timer = undefined
  }
}

function gotoStep(i: number) {
  playing.value = false
  if (timer) {
    window.clearInterval(timer)
    timer = undefined
  }
  step.value = i
}

watch(activeSheet, () => {
  playing.value = false
  if (timer) {
    window.clearInterval(timer)
    timer = undefined
  }
  step.value = 0
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})

const allStepsText = computed(() => {
  const lines: string[] = []
  const c = currentVerdict.value?.cutter
  if (c) lines.push(`【裁切设备】${c.name}（${c.maxSheetWMm}×${c.maxSheetHMm}mm，最小条宽 ${c.minStripMm || '不限'}mm，刀口 ${c.bladeMm}mm，单张 ${c.maxCutsPerSheet || '不限'} 刀）`)
  for (let si = 0; si < sheets.value.length; si++) {
    const s = sheets.value[si]
    lines.push(`【第 ${s.index + 1} 张相纸】${paper.value.wMm}×${paper.value.hMm}mm，共 ${s.cutSteps.length} 刀`)
    const sv = currentVerdict.value?.sheetVerdicts[si]
    if (sv && !sv.ok) lines.push(`  ✗ ${sv.fails.map((f) => f.message).join('；')}`)
    s.cutSteps.forEach((cc, i) => {
      lines.push(`  ${describe({ ...cc, sheetIndex: s.index }, i)}${sv ? '；' + metricTextOf(sv, i) : ''}`)
    })
  }
  return lines.join('\n')
})

function printList() {
  window.print()
}

function goto(routeName: string) {
  const t = task.value
  if (t) router.push(`/${routeName}/${t.id}`)
}

// 切到裁切页时默认展开一次换纸试算入口（不自动算）
watch(
  () => route.params.id,
  () => {
    paperSuggestOpen.value = false
    paperSuggestions.value = []
  },
)
</script>

<template>
  <div v-if="!task" class="card">
    <h2>任务不存在</h2>
    <p>请回到<a href="/">新建任务</a>页重新创建。</p>
  </div>
  <div v-else class="stack">
    <div class="row no-print">
      <h1 style="margin: 0">裁切步骤</h1>
      <span class="badge brand">{{ task.name }}</span>
      <span class="badge">{{ sheets.length }} 张相纸</span>
      <span class="badge">
        本张 {{ totalSteps }} 刀（未合并 {{ sheet?.rawCutCount ?? 0 }} 刀）
      </span>
      <div class="spacer"></div>
      <button class="btn" @click="goto('layout')">← 排样预览</button>
      <button class="btn" @click="printList">打印步骤清单</button>
      <button class="btn primary" @click="goto('export')">导出 1:1 →</button>
    </div>

    <div v-if="task.manual && !task.manual.valid" class="note danger no-print">
      手工微调后的排样不满足 guillotine 贯通裁切，导出已停用：{{ task.manual.message }}
    </div>

    <!-- 设备选择 + 总判定 -->
    <div class="card no-print">
      <h3>
        设备适配判定
        <span class="row tight">
          <RouterLink class="btn link small" to="/cutters">管理设备档案 →</RouterLink>
        </span>
      </h3>
      <div class="card-sub">
        按当前排样（含手工调整后的摆位）逐台机器逐刀判定；切完一张纸前就能看到这台机器到底能不能裁
      </div>
      <div class="row" style="align-items: flex-end">
        <label class="field" style="min-width: 280px">
          本机使用
          <select :value="selectedCutterId" @change="selectCutter(String(($event.target as HTMLSelectElement).value))">
            <option v-for="v in verdicts" :key="v.cutter.id" :value="v.cutter.id">
              {{ v.cutter.name }}{{ v.ok ? ' ✓ 可裁' : ' ✗ 不适合' }}
            </option>
          </select>
        </label>
        <span v-if="currentVerdict" class="badge" :class="currentVerdict.ok ? 'ok' : 'danger'" style="font-size: 12.5px; line-height: 24px">
          {{ currentVerdict.ok ? '✓ 本方案在这台机器上每张纸都能裁' : '✗ 这台机器裁不了当前方案' }}
        </span>
        <span v-if="currentVerdict" class="badge">
          可裁 {{ suitableVerdicts.length }} / {{ verdicts.length }} 台
        </span>
      </div>

      <template v-if="currentVerdict">
        <!-- 当前机器不行：逐条写清原因 + 改纸/换设备建议 -->
        <div v-if="!currentVerdict.ok" class="stack" style="margin-top: 10px">
          <div class="note danger" style="font-size: 13px">
            <strong>不能裁的原因：</strong>
            <ul style="margin: 6px 0 0; padding-left: 18px">
              <li v-for="(f, i) in currentVerdict.jobFails" :key="'j' + i">{{ f.message }}</li>
              <template v-for="(sv, si) in currentVerdict.sheetVerdicts" :key="'s' + si">
                <li v-for="(f, fi) in sv.fails" :key="'f' + si + '-' + fi">
                  第 {{ sv.sheetIndex + 1 }} 张：{{ f.message }}
                </li>
              </template>
            </ul>
          </div>
          <div v-if="currentVerdict.suggestions.length" class="note warn" style="font-size: 13px">
            <strong>怎么办：</strong>
            <ul style="margin: 6px 0 0; padding-left: 18px">
              <li v-for="(s, i) in currentVerdict.suggestions" :key="i">{{ s }}</li>
            </ul>
          </div>
          <div class="row">
            <button class="btn small" @click="runPaperSuggest">
              试算这台机器能裁的纸（当场换纸重排）
            </button>
            <button
              v-if="currentVerdict.jobFails.some((f) => f.kind === 'blade')"
              class="btn small"
              @click="fixKerfAndRepack"
            >
              把刀宽补偿调到 {{ currentVerdict.cutter.bladeMm }}mm 并重新排样
            </button>
          </div>
          <div v-if="paperSuggestOpen" class="card" style="padding: 10px; box-shadow: none">
            <div v-if="!paperSuggestions.length" class="note">
              尺寸库里没有这台机器幅面内、且重排后其它条件也全部满足的纸；请到「尺寸库」加纸，或换一台设备
            </div>
            <table v-else class="data">
              <thead>
                <tr>
                  <th>换成</th>
                  <th class="num">幅面 mm</th>
                  <th class="num">重排张数</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in paperSuggestions" :key="s.paper.id">
                  <td>{{ s.paper.name }}</td>
                  <td class="num">{{ s.paper.wMm }}×{{ s.paper.hMm }}</td>
                  <td class="num">{{ s.sheetCount }}</td>
                  <td>
                    <button class="btn small primary" @click="applyPaper(s.paper.id)">换这张并重新排样</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <!-- 同一版面有别的机器能直接裁，不必换纸 -->
          <div v-if="suitableVerdicts.length" class="note ok" style="font-size: 13px">
            也可以不换纸，直接改用：
            <strong>{{ suitableVerdicts.map((v) => v.cutter.name).join('、') }}</strong>
            （上方下拉切换即可，当前相纸 {{ paper.wMm }}×{{ paper.hMm }}mm 不用动）
          </div>
        </div>

        <!-- 当前机器可以：给出叠裁建议 -->
        <div v-else-if="currentVerdict.layerHints.length" class="note ok" style="margin-top: 10px; font-size: 13px">
          <template v-for="(h, i) in currentVerdict.layerHints" :key="i">
            第 {{ h.sheets.join('、') }} 张版面相同，各 {{ h.copies }} 张：
            <strong>{{ h.ok ? `可一叠 ${h.copies} 张一起压` : `要分 ${h.stacks} 叠（每叠 ≤ ${h.maxLayers} 张）` }}</strong>
            。<br v-if="i < currentVerdict.layerHints.length - 1" />
          </template>
        </div>
      </template>
    </div>

    <!-- 逐台机器清单（适合 / 不适合，不适合的标清类别）-->
    <div class="card no-print">
      <h3>全部机器判定（{{ cutters.length }} 台）</h3>
      <div class="grid cols-2">
        <div v-for="v in verdicts" :key="v.cutter.id" class="mini-cutter" :class="{ bad: !v.ok }">
          <div class="row" style="justify-content: space-between">
            <strong>{{ v.cutter.name }}</strong>
            <span class="badge" :class="v.ok ? 'ok' : 'danger'">{{ v.ok ? '适合' : '不适合' }}</span>
          </div>
          <div class="mono" style="font-size: 11.5px; color: var(--ink-3); margin: 4px 0">
            幅面 ≤{{ v.cutter.maxSheetWMm }}×{{ v.cutter.maxSheetHMm }} ｜ 条 ≥{{ v.cutter.minStripMm || '—' }} ｜
            刀口 {{ v.cutter.bladeMm }} ｜ {{ v.cutter.maxCutsPerSheet || '∞' }} 刀/张
          </div>
          <div v-if="v.ok" class="mono" style="font-size: 11.5px; color: var(--ok)">
            {{ sheets.length }} 张共 {{ v.sheetVerdicts.reduce((n, s) => n + s.analysis.cutCount, 0) }} 刀；最长刀
            {{ Math.max(...v.sheetVerdicts.map((s) => s.analysis.maxCutLength)) }}mm、最窄条
            {{ Math.min(...v.sheetVerdicts.map((s) => s.analysis.narrowestStrip)) }}mm，全部满足
          </div>
          <div v-else class="row tight" style="margin-top: 2px">
            <span
              v-for="(k, i) in [...new Set([
                ...v.jobFails.map((f) => f.kind),
                ...v.sheetVerdicts.flatMap((sv) => sv.fails.map((f) => f.kind)),
              ])]"
              :key="i"
              class="badge danger"
              style="font-size: 11px"
            >
              {{ FAIL_KIND_LABEL[k as keyof typeof FAIL_KIND_LABEL] }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <div class="grid sidebar no-print">
      <div class="stack">
        <div class="card">
          <h3>
            纸面视图
            <span class="badge">{{ step >= totalSteps ? '已切完' : `当前第 ${step + 1} 刀` }}</span>
          </h3>
          <div class="card-sub">灰线 = 待切，红线 = 当前这一刀，绿线 = 已完成</div>
          <div class="row" style="margin-bottom: 8px">
            <button
              v-for="(s, i) in sheets"
              :key="s.index"
              class="btn small"
              :class="{ primary: i === activeSheet }"
              @click="activeSheet = i"
            >
              第 {{ i + 1 }} 张
              <span v-if="verdicts.length && currentVerdict">
                {{ currentVerdict.sheetVerdicts[i]?.ok ? '✓' : '✗' }}
              </span>
            </button>
          </div>
          <div v-if="sheet" class="sheet-wrap">
            <SheetView
              :sheet="sheet"
              :paper="paper"
              :safe-edge-mm="task.safeEdgeMm"
              :scale="scale"
              :highlight="step < totalSteps ? step : -1"
              :done-count="step"
              :show-cut-labels="true"
              :thumb-of="thumbs"
            />
          </div>
        </div>
      </div>

      <div class="stack">
        <!-- 本张纸在当前机器下的逐项指标 -->
        <div v-if="currentSheetVerdict" class="card" :class="currentSheetVerdict.ok ? '' : 'card-bad'">
          <h3>
            第 {{ activeSheet + 1 }} 张 · {{ currentVerdict?.cutter.name }}
            <span class="badge" :class="currentSheetVerdict.ok ? 'ok' : 'danger'">
              {{ currentSheetVerdict.ok ? '能裁' : '不能裁' }}
            </span>
          </h3>
          <div class="kv">
            <dt>本张总刀数</dt>
            <dd>{{ currentSheetVerdict.analysis.cutCount }} 刀</dd>
            <dt>最长一刀</dt>
            <dd>
              第 {{ currentSheetVerdict.analysis.longestStep }} 刀，
              {{ currentSheetVerdict.analysis.maxCutLength }}mm
              <small style="color: var(--ink-3)">/ 刀门 {{ Math.max(currentVerdict!.cutter.maxSheetWMm, currentVerdict!.cutter.maxSheetHMm) }}mm</small>
            </dd>
            <dt>最窄含照片条</dt>
            <dd>
              第 {{ currentSheetVerdict.analysis.narrowestStep }} 刀夹出
              {{ currentSheetVerdict.analysis.narrowestStrip }}mm
              <small style="color: var(--ink-3)">/ 后挡规 ≥ {{ currentVerdict!.cutter.minStripMm || '不限' }}mm</small>
            </dd>
          </div>
          <div v-if="sheets.length > 1" class="note" style="margin-top: 6px; font-size: 12px">
            整单 {{ sheets.length }} 张：最长刀 {{ jobMaxCut.length }}mm（第 {{ jobMaxCut.sheet }} 张第
            {{ jobMaxCut.step }} 刀）；最窄条 {{ jobNarrowest.width }}mm（第 {{ jobNarrowest.sheet }} 张第
            {{ jobNarrowest.step }} 刀）
          </div>
          <div v-for="(f, i) in currentSheetVerdict.fails" :key="i" class="note danger" style="margin-top: 6px">
            {{ f.message }}
          </div>
          <div v-if="step < totalSteps" class="note" :class="isStepViolation(step) ? 'danger' : 'ok'" style="margin-top: 8px">
            当前第 {{ step + 1 }} 刀：{{ metricText(step) }}
            <template v-if="isStepViolation(step) === 'long'">→ 超过刀门，这刀切不下去</template>
            <template v-else-if="isStepViolation(step) === 'narrow'">→ 条太窄，本机后挡规定不住</template>
            <template v-else>→ 本机可切</template>
          </div>
        </div>

        <div class="card">
          <h3>播放控制</h3>
          <div class="row">
            <button class="btn small" @click="gotoStep(0)">⏮ 重置</button>
            <button class="btn small" :disabled="step <= 0" @click="gotoStep(step - 1)">上一步</button>
            <button class="btn primary small" @click="togglePlay">
              {{ playing ? '⏸ 暂停' : '▶ 播放' }}
            </button>
            <button class="btn small" :disabled="step >= totalSteps" @click="gotoStep(step + 1)">
              下一步
            </button>
            <button class="btn small" @click="gotoStep(totalSteps)">全部切完</button>
          </div>
          <div class="note" style="margin-top: 8px">
            {{ step >= totalSteps ? '全部切割线已完成，按编号取照片即可。' : describe(steps[step], step) }}
          </div>
        </div>

        <div class="card">
          <h3>
            步骤清单（第 {{ activeSheet + 1 }} 张）
            <span v-if="currentVerdict" class="badge" :class="currentSheetVerdict?.ok ? 'ok' : 'danger'">
              {{ currentVerdict?.cutter.name }}
            </span>
          </h3>
          <div class="card-sub">
            每一刀标注实际刀长与相邻刀线夹出的条宽；<i class="mono">条太窄</i>/<i class="mono">刀太长</i> 的步骤红底标出
          </div>
          <div class="steps">
            <div
              v-for="(c, i) in steps"
              :key="i"
              class="step"
              :class="{
                active: i === step,
                done: i < step,
                violation: isStepViolation(i) !== null,
              }"
              @click="gotoStep(i)"
            >
              <span class="idx">{{ i + 1 }}</span>
              <span style="flex: 1">
                {{ describe(c, i) }}
                <span class="mono" style="display: block; color: var(--ink-3); font-size: 11.5px">
                  {{ metricText(i) }}
                </span>
              </span>
              <span v-if="isStepViolation(i) === 'narrow'" class="badge danger">条太窄</span>
              <span v-else-if="isStepViolation(i) === 'long'" class="badge danger">刀太长</span>
              <span v-else-if="c.merged" class="badge ok">共边合并</span>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>刀口说明</h3>
          <div class="kv">
            <dt>相邻照片间距</dt>
            <dd>{{ task.gapMm }} mm</dd>
            <dt>刀宽补偿</dt>
            <dd>{{ task.kerfMm }} mm（从照片外侧向内缩）</dd>
            <dt>本机刀口</dt>
            <dd>{{ currentVerdict?.cutter.bladeMm ?? '—' }} mm</dd>
            <dt>四周安全边</dt>
            <dd>{{ task.safeEdgeMm }} mm</dd>
            <dt>纸边留白</dt>
            <dd>{{ paper.marginMm }} mm</dd>
          </div>
        </div>
      </div>
    </div>

    <!-- 打印版：贴在裁切台上 -->
    <div class="print-only">
      <h2>{{ task.name }} · 切割步骤清单</h2>
      <p class="mono">
        设备：{{ currentVerdict?.cutter.name ?? '未选择' }} ｜ 相纸 {{ paper.name }} {{ paper.wMm }}×{{ paper.hMm }}mm ｜
        隙距 {{ task.gapMm }}mm ｜ 刀宽补偿 {{ task.kerfMm }}mm ｜ 安全边 {{ task.safeEdgeMm }}mm
      </p>
      <p v-if="currentVerdict && !currentVerdict.ok" class="mono" style="color: #c62828">
        注意：该设备不能裁此方案（{{ [
          ...currentVerdict.jobFails.map((f) => f.message),
          ...currentVerdict.sheetVerdicts.flatMap((sv) => sv.fails.map((f) => f.message)),
        ].join('；') }}）
      </p>
      <RulerScale unit="mm" :length-mm="100" />
      <p style="margin-top: 8px">请按 100% 实际大小打印（关闭「适应页面 / Fit to page」）。</p>
      <pre class="mono" style="white-space: pre-wrap; font-size: 12px">{{ allStepsText }}</pre>
    </div>
  </div>
</template>
