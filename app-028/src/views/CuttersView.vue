<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  addCutter,
  BUILTIN_CUTTERS,
  cutters,
  removeCutter,
  resetAllBuiltinCutters,
  resetBuiltinCutter,
  updateCutter,
} from '../store'
import { CUTTER_KIND_LABEL } from '../logic/cutter'
import type { Cutter, CutterKind } from '../logic/types'

interface CutterForm {
  id: string | null
  name: string
  kind: CutterKind
  maxSheetWMm: number
  maxSheetHMm: number
  minSheetWMm: number
  minSheetHMm: number
  minStripMm: number
  bladeMm: number
  maxLayers: number
  maxCutsPerSheet: number
  note: string
}

function emptyForm(): CutterForm {
  return {
    id: null,
    name: '',
    kind: 'guillotine',
    maxSheetWMm: 460,
    maxSheetHMm: 460,
    minSheetWMm: 0,
    minSheetHMm: 0,
    minStripMm: 30,
    bladeMm: 0.5,
    maxLayers: 1,
    maxCutsPerSheet: 0,
    note: '',
  }
}

const form = reactive<CutterForm>(emptyForm())
const error = ref('')
const msg = ref('')
const isEdit = computed(() => form.id !== null)

const builtinIds = new Set(BUILTIN_CUTTERS.map((c) => c.id))

function beginAdd() {
  Object.assign(form, emptyForm())
  error.value = ''
}

function beginEdit(c: Cutter) {
  Object.assign(form, {
    id: c.id,
    name: c.name,
    kind: c.kind,
    maxSheetWMm: c.maxSheetWMm,
    maxSheetHMm: c.maxSheetHMm,
    minSheetWMm: c.minSheetWMm,
    minSheetHMm: c.minSheetHMm,
    minStripMm: c.minStripMm,
    bladeMm: c.bladeMm,
    maxLayers: c.maxLayers,
    maxCutsPerSheet: c.maxCutsPerSheet,
    note: c.note,
  })
  error.value = ''
  window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })
}

function validate(): string {
  if (!form.name.trim()) return '请填写设备名称'
  for (const [k, label] of [
    ['maxSheetWMm', '最大可裁幅面宽'],
    ['maxSheetHMm', '最大可裁幅面高'],
    ['bladeMm', '刀口宽度'],
  ] as const) {
    if (form[k] < 0) return `${label}不能为负`
  }
  if (form.maxSheetWMm <= 0 || form.maxSheetHMm <= 0) return '最大可裁幅面必须大于 0'
  if (form.minSheetWMm > form.maxSheetWMm || form.minSheetHMm > form.maxSheetHMm) {
    return '最小可裁幅面不能大于最大可裁幅面'
  }
  return ''
}

function save() {
  error.value = validate()
  if (error.value) return
  const payload = {
    name: form.name.trim(),
    kind: form.kind,
    maxSheetWMm: Number(form.maxSheetWMm),
    maxSheetHMm: Number(form.maxSheetHMm),
    minSheetWMm: Number(form.minSheetWMm),
    minSheetHMm: Number(form.minSheetHMm),
    minStripMm: Number(form.minStripMm),
    bladeMm: Number(form.bladeMm),
    maxLayers: Number(form.maxLayers),
    maxCutsPerSheet: Number(form.maxCutsPerSheet),
    note: form.note.trim(),
  }
  if (form.id) {
    updateCutter(form.id, payload)
    msg.value = `已保存「${payload.name}」的参数修改`
  } else {
    addCutter(payload)
    msg.value = `已登记新设备「${payload.name}」`
  }
  Object.assign(form, emptyForm())
}

function del(c: Cutter) {
  if (builtinIds.has(c.id)) return
  if (!window.confirm(`确定删除设备「${c.name}」？`)) return
  removeCutter(c.id)
  if (form.id === c.id) Object.assign(form, emptyForm())
  msg.value = `已删除「${c.name}」`
}

function resetOne(c: Cutter) {
  resetBuiltinCutter(c.id)
  if (form.id === c.id) beginEdit({ ...BUILTIN_CUTTERS.find((b) => b.id === c.id)! })
  msg.value = `「${c.name}」已恢复出厂参数`
}

function orDash(n: number): string {
  return n > 0 ? String(n) : '不限'
}
</script>

<template>
  <div class="stack">
    <div class="row">
      <h1 style="margin: 0">裁切设备档案</h1>
      <span class="badge brand">{{ cutters.length }} 台设备</span>
      <div class="spacer"></div>
      <button class="btn small" @click="resetAllBuiltinCutters">内置机全部恢复出厂</button>
      <button class="btn primary" @click="beginAdd">＋ 登记新设备</button>
    </div>
    <div class="note">
      排样方案出来后，系统拿每一张纸的切割步骤逐台判定：每一刀切多长（刀门/导轨）、相邻刀线夹出的条有多窄（最小条宽 /
      后挡规）、一共几刀（单张刀数上限）、刀口厚度是否超过排样预留的刀宽补偿。判定结果见「裁切步骤」页。
    </div>
    <div v-if="error" class="note danger">{{ error }}</div>
    <div v-if="msg" class="note ok">{{ msg }}</div>

    <div class="card">
      <h3>设备清单</h3>
      <div class="card-sub">单位均为 mm；「不限」用 0 表示。内置机可改参数、可恢复出厂；自定义机可删除</div>
      <div style="overflow: auto">
        <table class="data">
          <thead>
            <tr>
              <th>设备</th>
              <th>类型</th>
              <th class="num">最大幅面</th>
              <th class="num">最小幅面</th>
              <th class="num">最小条宽</th>
              <th class="num">刀口宽</th>
              <th class="num">单次层数</th>
              <th class="num">单张刀数</th>
              <th>备注</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in cutters" :key="c.id">
              <td>
                {{ c.name }}
                <span class="badge" :class="builtinIds.has(c.id) ? '' : 'brand'">
                  {{ builtinIds.has(c.id) ? '内置' : '自定义' }}
                </span>
              </td>
              <td>{{ CUTTER_KIND_LABEL[c.kind] }}</td>
              <td class="num">{{ c.maxSheetWMm }}×{{ c.maxSheetHMm }}</td>
              <td class="num">
                {{ c.minSheetWMm || c.minSheetHMm ? `${c.minSheetWMm}×${c.minSheetHMm}` : '不限' }}
              </td>
              <td class="num">{{ orDash(c.minStripMm) }}</td>
              <td class="num">{{ c.bladeMm }}</td>
              <td class="num">{{ orDash(c.maxLayers) }}</td>
              <td class="num">{{ orDash(c.maxCutsPerSheet) }}</td>
              <td style="font-size: 12px; color: var(--ink-2); max-width: 240px">{{ c.note }}</td>
              <td>
                <div class="row tight">
                  <button class="btn small" @click="beginEdit(c)">编辑</button>
                  <button v-if="builtinIds.has(c.id)" class="btn small" @click="resetOne(c)">恢复</button>
                  <button v-else class="btn small danger" @click="del(c)">删除</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <h3>{{ isEdit ? '编辑设备参数' : '登记新设备' }}</h3>
      <div class="card-sub">
        最大幅面：纸张宽高都不得超过（上刀时允许把纸转 90°）；最小幅面：纸太小压不住；最小条宽：后挡规能定到的最窄距离
      </div>
      <div class="grid cols-4">
        <label class="field">
          设备名称
          <input v-model="form.name" type="text" placeholder="如 5 号 · 台式小铡刀" />
        </label>
        <label class="field">
          类型
          <select v-model="form.kind">
            <option value="roller">手工裁刀（滚轮刀）</option>
            <option value="guillotine">铡刀（手动平压）</option>
            <option value="electric">电动裁切机</option>
          </select>
        </label>
        <label class="field">
          最大可裁幅面 宽 mm
          <input v-model.number="form.maxSheetWMm" type="number" min="1" step="1" />
        </label>
        <label class="field">
          最大可裁幅面 高 mm
          <input v-model.number="form.maxSheetHMm" type="number" min="1" step="1" />
        </label>
        <label class="field">
          最小可裁幅面 宽 mm（0 不限）
          <input v-model.number="form.minSheetWMm" type="number" min="0" step="1" />
        </label>
        <label class="field">
          最小可裁幅面 高 mm（0 不限）
          <input v-model.number="form.minSheetHMm" type="number" min="0" step="1" />
        </label>
        <label class="field">
          最小条宽 mm（0 不限）
          <input v-model.number="form.minStripMm" type="number" min="0" step="0.5" />
        </label>
        <label class="field">
          刀口宽度 mm
          <input v-model.number="form.bladeMm" type="number" min="0" step="0.1" />
        </label>
        <label class="field">
          单次可裁层数（0 不限）
          <input v-model.number="form.maxLayers" type="number" min="0" step="1" />
        </label>
        <label class="field">
          单张最多刀数（0 不限）
          <input v-model.number="form.maxCutsPerSheet" type="number" min="0" step="1" />
        </label>
        <label class="field" style="grid-column: span 2">
          备注（老师傅经验）
          <input v-model="form.note" type="text" placeholder="如：窄条跑偏、适合批量活……" />
        </label>
      </div>
      <div class="row" style="margin-top: 12px">
        <button class="btn primary" @click="save">{{ isEdit ? '保存修改' : '登记入册' }}</button>
        <button v-if="isEdit" class="btn" @click="beginAdd">取消编辑</button>
      </div>
    </div>
  </div>
</template>
