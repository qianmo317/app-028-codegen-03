<script setup lang="ts">
import { reactive, ref } from 'vue'
import {
  addCustomCutter,
  allCutters,
  removeCustomCutter,
  selectCutter,
  selectedCutterId,
} from '../store'
import type { CutterKind } from '../logic/types'

const error = ref('')
const msg = ref('')

const KIND_LABEL: Record<CutterKind, string> = {
  trimmer: '裁刀（滚轮推刀）',
  guillotine: '铡刀（厚层闸刀）',
  electric: '电动裁切机（程控电刀）',
}

const form = reactive({
  name: '',
  kind: 'guillotine' as CutterKind,
  maxWmm: 320,
  maxHmm: 450,
  minWmm: 50,
  minHmm: 50,
  minStripMm: 15,
  bladeMm: 0.5,
  maxLayers: 5,
  maxCutsPerSheet: 0,
  note: '',
})

function resetForm() {
  form.name = ''
  form.kind = 'guillotine'
  form.maxWmm = 320
  form.maxHmm = 450
  form.minWmm = 50
  form.minHmm = 50
  form.minStripMm = 15
  form.bladeMm = 0.5
  form.maxLayers = 5
  form.maxCutsPerSheet = 0
  form.note = ''
}

function addCutter() {
  error.value = ''
  if (!form.name.trim()) {
    error.value = '请填写设备名称（如「4 号新铡刀」）'
    return
  }
  if (form.maxWmm <= 0 || form.maxHmm <= 0 || form.minWmm <= 0 || form.minHmm <= 0) {
    error.value = '幅面数值必须大于 0'
    return
  }
  if (form.minWmm > form.maxWmm || form.minHmm > form.maxHmm) {
    error.value = '最小可裁幅面不能大于最大可裁幅面'
    return
  }
  if (form.minStripMm <= 0) {
    error.value = '最小条宽必须大于 0'
    return
  }
  if (form.bladeMm < 0) {
    error.value = '刀口宽度不能为负'
    return
  }
  if (form.maxLayers < 1) {
    error.value = '单次可裁层数至少为 1'
    return
  }
  if (form.maxCutsPerSheet < 0) {
    error.value = '单张刀数上限填 0 表示不限，不能为负'
    return
  }
  addCustomCutter({
    ...form,
    name: form.name.trim(),
    note: form.note.trim(),
  })
  msg.value = `已登记设备「${form.name.trim()}」，排样预览与裁切步骤页可直接选用`
  resetForm()
}
</script>

<template>
  <div class="stack">
    <div class="row">
      <h1 style="margin: 0">设备档案</h1>
      <span class="badge brand">{{ allCutters.length }} 台裁切设备</span>
      <span class="badge">只存本机 localStorage</span>
    </div>
    <div class="note">
      把店里裁刀、铡刀、电动裁切机的参数逐台登记下来。排样方案出来后，系统拿它的切割步骤
      <b>逐台逐刀</b>判定：每一刀切多长、相邻两刀夹出的条有多窄、这张纸一共几刀，
      然后给出适合的机器清单；不适合的会写明是「幅面超了 / 有条太窄 / 刀数太多 / 刀口太宽」，
      并给出改纸或换设备的建议。
    </div>
    <div v-if="error" class="note danger">{{ error }}</div>
    <div v-if="msg" class="note ok">{{ msg }}</div>

    <div class="card">
      <h3>设备清单</h3>
      <div class="card-sub">点「用这台判定」可把它设为排样预览 / 裁切步骤页的当前设备</div>
      <table class="data">
        <thead>
          <tr>
            <th>设备</th>
            <th>类型</th>
            <th class="num">最大可裁幅面 mm</th>
            <th class="num">最小可裁幅面 mm</th>
            <th class="num">最小条宽</th>
            <th class="num">刀口宽度</th>
            <th class="num">单次层数</th>
            <th class="num">单张刀数</th>
            <th>来源</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in allCutters" :key="c.id">
            <td>
              {{ c.name }}
              <div class="mono" style="font-size: 11.5px; color: var(--ink-3)">{{ c.note }}</div>
              <span v-if="c.id === selectedCutterId" class="badge brand" style="margin-top: 2px">
                当前选用
              </span>
            </td>
            <td>{{ KIND_LABEL[c.kind] }}</td>
            <td class="num">{{ c.maxWmm }} × {{ c.maxHmm }}</td>
            <td class="num">{{ c.minWmm }} × {{ c.minHmm }}</td>
            <td class="num">{{ c.minStripMm }} mm</td>
            <td class="num">{{ c.bladeMm }} mm</td>
            <td class="num">{{ c.maxLayers }} 层</td>
            <td class="num">{{ c.maxCutsPerSheet === 0 ? '不限' : c.maxCutsPerSheet + ' 刀' }}</td>
            <td>
              <span class="badge" :class="c.builtin ? '' : 'brand'">
                {{ c.builtin ? '内置示例' : '自登记' }}
              </span>
            </td>
            <td>
              <div class="row tight">
                <button
                  v-if="c.id !== selectedCutterId"
                  class="btn small"
                  @click="selectCutter(c.id)"
                >
                  用这台判定
                </button>
                <button
                  v-if="!c.builtin"
                  class="btn small danger"
                  @click="removeCustomCutter(c.id)"
                >
                  删除
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="card">
      <h3>登记新设备</h3>
      <div class="card-sub">拿尺量台面与靠规后如实填写；内置三台只是示例参数，请按自家机器修正</div>
      <div class="grid cols-4">
        <label class="field">
          设备名称
          <input v-model="form.name" type="text" placeholder="如 4 号新铡刀" />
        </label>
        <label class="field">
          设备类型
          <select v-model="form.kind">
            <option v-for="(label, key) in KIND_LABEL" :key="key" :value="key">{{ label }}</option>
          </select>
        </label>
        <label class="field">
          最大幅面 宽 mm
          <input v-model.number="form.maxWmm" type="number" min="10" step="1" />
        </label>
        <label class="field">
          最大幅面 高 mm
          <input v-model.number="form.maxHmm" type="number" min="10" step="1" />
        </label>
        <label class="field">
          最小幅面 宽 mm
          <input v-model.number="form.minWmm" type="number" min="0" step="1" />
        </label>
        <label class="field">
          最小幅面 高 mm
          <input v-model.number="form.minHmm" type="number" min="0" step="1" />
        </label>
        <label class="field">
          最小条宽 mm
          <input v-model.number="form.minStripMm" type="number" min="1" step="0.5" />
        </label>
        <label class="field">
          刀口宽度 mm
          <input v-model.number="form.bladeMm" type="number" min="0" step="0.1" />
        </label>
        <label class="field">
          单次可裁层数
          <input v-model.number="form.maxLayers" type="number" min="1" step="1" />
        </label>
        <label class="field">
          单张最多刀数（0=不限）
          <input v-model.number="form.maxCutsPerSheet" type="number" min="0" step="1" />
        </label>
        <label class="field" style="grid-column: span 2">
          备注（压不住的尺寸、老师傅经验等）
          <input v-model="form.note" type="text" placeholder="如 15mm 以下的条得换 1 号推刀" />
        </label>
      </div>
      <div class="row" style="margin-top: 10px">
        <button class="btn primary" @click="addCutter">登记这台设备</button>
        <button class="btn" @click="resetForm">清空</button>
      </div>
    </div>
  </div>
</template>
