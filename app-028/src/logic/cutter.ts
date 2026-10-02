/**
 * 设备档案判定核心：拿排样方案的切割步骤逐台设备判定能不能裁。
 *
 * 每张纸逐刀重放（与 guillotine.validateCutSequence 同一套几何），判定：
 *  1. 幅面：纸张短/长边是否落在设备「最小可裁幅面 ~ 最大可裁幅面」内（允许转 90°）；
 *     每一刀的刀长不得超过设备最大幅面对应方向（否则属于「幅面超了」）。
 *  2. 条宽：每一刀切完后两侧夹出来的条有多窄，取全纸最窄值对比 minStripMm。
 *     只统计「成品条」——照片与照片之间的共边刀（internal）；外侧修边刀切下的
 *     是纸边废料（大边由压规压住、废料条直接掉落），不算「两刀夹出来的条」。
 *  3. 刀数：本张总刀数对比 maxCutsPerSheet（0 = 不限）。
 *  4. 刀口：设备刀口宽度不得大于排样为内部共边刀预留的切缝（kerf + gap），
 *     否则会啃进照片（修边刀切在外侧废料上，不受此限）。
 */
import { EPS, validateCutSequence, type Rect } from './guillotine'
import { pack, type PackOptions } from './packer'
import { round } from './units'
import type { Cutter, Paper, Sheet } from './types'

export type CutterFailCode = 'format' | 'strip' | 'cuts' | 'blade'

export const FAIL_LABEL: Record<CutterFailCode, string> = {
  format: '幅面超了',
  strip: '有条太窄',
  cuts: '刀数太多',
  blade: '刀口太宽',
}

export interface CutMeasure {
  /** 0-based 刀序 */
  index: number
  axis: 'v' | 'h'
  /** 这一刀切多长（mm） */
  lengthMm: number
  /** 这一刀两侧夹出来的较窄条宽（mm） */
  stripMm: number
  /** 是否为落在照片之间的内部刀（共边刀）；false = 外侧修边刀 */
  internal: boolean
}

export interface CutterSheetVerdict {
  sheetIndex: number
  ok: boolean
  /** 不适合的原因（可多个同时存在） */
  failures: CutterFailCode[]
  /** 判定依据：本张总刀数 */
  cutCount: number
  /** 本张最长的一刀切多长 */
  longestCutMm: number
  /** 相邻两刀（照片之间的共边刀）夹出来的最窄成品条；无内部刀时为 0 */
  narrowestStripMm: number
  /** 含外侧修边刀在内的最窄切边（仅供参考展示，不参与判定） */
  narrowestEdgeMm: number
  /** 逐刀测量数据（UI 按选中的机器显示能不能裁） */
  measures: CutMeasure[]
  /** 逐条人话说明（含数值） */
  details: string[]
}

export interface CutterVerdict {
  cutter: Cutter
  /** 所有纸张都能裁才算适合 */
  ok: boolean
  sheets: CutterSheetVerdict[]
  /** 本方案适合时可叠层裁切的建议（相同版面的纸张） */
  stackAdvice: string
}

interface ReplayItem {
  /** 这一刀的测量值 */
  measure: CutMeasure
  /** 切完后的全部纸条（含后续还要再切的中间条） */
  pieces: Rect[]
}

/** 照片切块（刀口从照片外侧补偿），与 packer 保持一致 */
export function slotsOfSheet(sheet: Sheet, opts: PackOptions): Rect[] {
  const m = (opts.kerfMm + opts.gapMm) / 2
  return sheet.placements.map((p) => ({ x: p.x - m, y: p.y - m, w: p.w + 2 * m, h: p.h + 2 * m }))
}

function regionOf(opts: PackOptions): Rect {
  const inset = opts.marginMm + opts.safeEdgeMm
  return { x: inset, y: inset, w: opts.paperW - 2 * inset, h: opts.paperH - 2 * inset }
}

/**
 * 逐刀重放一张纸的切割步骤，返回每一刀的刀长 / 夹出的条宽 / 是否内部刀。
 * 同时返回最终纸条（成品 + 废料边条）。切割序列不合法时返回 null。
 */
export function replayCuts(
  region: Rect,
  slots: Rect[],
  sheet: Sheet,
): { items: ReplayItem[]; finalPieces: Rect[] } | null {
  const cuts = sheet.cutSteps
  const validation = validateCutSequence(region, slots, cuts)
  if (!validation.ok) return null

  let pieces: Rect[] = [{ ...region }]
  const items: ReplayItem[] = []

  cuts.forEach((c, index) => {
    const affected: Rect[] = []
    for (const p of pieces) {
      if (c.axis === 'v') {
        if (
          p.x < c.at - EPS &&
          c.at < p.x + p.w - EPS &&
          c.from <= p.y + EPS &&
          p.y + p.h <= c.to + EPS
        ) {
          affected.push(p)
        }
      } else if (
        p.y < c.at - EPS &&
        c.at < p.y + p.h - EPS &&
        c.from <= p.x + EPS &&
        p.x + p.w <= c.to + EPS
      ) {
        affected.push(p)
      }
    }
    const lengthMm = c.to - c.from
    // 被这一刀切开的每个块，沿进刀方向分成左右（或上下）两条，取较窄值
    let stripMm = Infinity
    for (const p of affected) {
      if (c.axis === 'v') stripMm = Math.min(stripMm, c.at - p.x, p.x + p.w - c.at)
      else stripMm = Math.min(stripMm, c.at - p.y, p.y + p.h - c.at)
    }
    if (!isFinite(stripMm)) stripMm = 0
    // 内部刀 = 切开后两侧都还含照片切块（不是外侧修边）
    const slotSet = (r: Rect): boolean =>
      slots.some(
        (s) =>
          s.x >= r.x - EPS &&
          s.y >= r.y - EPS &&
          s.x + s.w <= r.x + r.w + EPS &&
          s.y + s.h <= r.y + r.h + EPS,
      )
    let internal = false
    for (const p of affected) {
      if (c.axis === 'v') {
        const left = { x: p.x, y: p.y, w: c.at - p.x, h: p.h }
        const right = { x: c.at, y: p.y, w: p.x + p.w - c.at, h: p.h }
        if (slotSet(left) && slotSet(right)) internal = true
      } else {
        const top = { x: p.x, y: p.y, w: p.w, h: c.at - p.y }
        const bottom = { x: p.x, y: c.at, w: p.w, h: p.y + p.h - c.at }
        if (slotSet(top) && slotSet(bottom)) internal = true
      }
    }

    const rest = pieces.filter((p) => !affected.includes(p))
    const next: Rect[] = []
    for (const p of affected) {
      if (c.axis === 'v') {
        next.push({ x: p.x, y: p.y, w: c.at - p.x, h: p.h })
        next.push({ x: c.at, y: p.y, w: p.x + p.w - c.at, h: p.h })
      } else {
        next.push({ x: p.x, y: p.y, w: p.w, h: c.at - p.y })
        next.push({ x: p.x, y: c.at, w: p.w, h: p.y + p.h - c.at })
      }
    }
    pieces = [...rest, ...next]
    items.push({
      measure: {
        index,
        axis: c.axis,
        lengthMm: round(lengthMm, 2),
        stripMm: round(Math.max(0, stripMm), 2),
        internal,
      },
      pieces: pieces.map((p) => ({ ...p })),
    })
  })

  return { items, finalPieces: pieces }
}

/** 纸张两个方向是否都能放上该设备的台面（允许整张纸转 90°） */
function sheetFitsCutter(paperW: number, paperH: number, cutter: Cutter): boolean {
  const lo = Math.min(paperW, paperH)
  const hi = Math.max(paperW, paperH)
  const cLo = Math.min(cutter.maxWmm, cutter.maxHmm)
  const cHi = Math.max(cutter.maxWmm, cutter.maxHmm)
  return lo <= cLo + EPS && hi <= cHi + EPS
}

function sheetAboveMin(paperW: number, paperH: number, cutter: Cutter): boolean {
  const lo = Math.min(paperW, paperH)
  const hi = Math.max(paperW, paperH)
  const mLo = Math.min(cutter.minWmm, cutter.minHmm)
  const mHi = Math.max(cutter.minWmm, cutter.minHmm)
  return lo >= mLo - EPS && hi >= mHi - EPS
}

/** 判定一台设备能不能裁一张相纸 */
export function judgeSheet(
  sheet: Sheet,
  paper: Paper,
  opts: PackOptions,
  cutter: Cutter,
): CutterSheetVerdict {
  const failures: CutterFailCode[] = []
  const details: string[] = []
  const cutCount = sheet.cutSteps.length

  // —— 幅面（含最小可裁幅面）——
  const fits = sheetFitsCutter(paper.wMm, paper.hMm, cutter)
  const aboveMin = sheetAboveMin(paper.wMm, paper.hMm, cutter)
  if (!fits) {
    failures.push('format')
    details.push(
      `幅面超了：相纸 ${paper.wMm}×${paper.hMm}mm 超过「${cutter.name}」最大可裁幅面 ${cutter.maxWmm}×${cutter.maxHmm}mm（已按可转 90° 比对）`,
    )
  }
  if (!aboveMin) {
    failures.push('format')
    details.push(
      `幅面太小：相纸 ${paper.wMm}×${paper.hMm}mm 小于该设备最小可裁幅面 ${cutter.minWmm}×${cutter.minHmm}mm，压不住 / 对不到靠规`,
    )
  }

  const region = regionOf(opts)
  const slots = slotsOfSheet(sheet, opts)
  const replay = cutCount > 0 ? replayCuts(region, slots, sheet) : null
  if (cutCount > 0 && !replay) {
    // 排样本身不满足 guillotine（手工微调失败）时不做后续判定
    failures.push('format')
    details.push('当前排样不满足 guillotine 贯通裁切，无法逐刀判定')
  }

  const measures = replay?.items.map((i) => i.measure) ?? []
  const longestCutMm = measures.reduce((acc, m) => Math.max(acc, m.lengthMm), 0)
  const internalMeasures = measures.filter((m) => m.internal)
  const narrowestStripMm = internalMeasures.reduce((acc, m) => Math.min(acc, m.stripMm), Infinity)
  const narrowestEdgeMm = measures.reduce((acc, m) => Math.min(acc, m.stripMm), Infinity)

  // 刀长超过台面：刀到底之前就出界，归入「幅面超了」
  const bladeReach = Math.max(cutter.maxWmm, cutter.maxHmm)
  if (longestCutMm > bladeReach + EPS && !failures.includes('format')) {
    failures.push('format')
    details.push(
      `幅面超了：第 ${measures.find((m) => m.lengthMm > bladeReach + EPS)!.index + 1} 刀长 ${longestCutMm.toFixed(1)}mm，超过该设备最大刀长 ${bladeReach}mm`,
    )
  }

  // —— 条太窄（只判照片之间的共边刀；外侧修边刀切掉的是废料，不参与）——
  if (
    replay &&
    internalMeasures.length > 0 &&
    isFinite(narrowestStripMm) &&
    narrowestStripMm + EPS < cutter.minStripMm
  ) {
    failures.push('strip')
    const worst = internalMeasures.reduce((a, b) => (b.stripMm < a.stripMm ? b : a))
    details.push(
      `有条太窄：第 ${worst.index + 1} 刀两侧夹出的成品条只有 ${worst.stripMm.toFixed(1)}mm，窄于该设备最小条宽 ${cutter.minStripMm}mm（外侧修边刀切掉的纸边废料不计）`,
    )
  }

  // —— 刀数太多 ——
  if (cutter.maxCutsPerSheet > 0 && cutCount > cutter.maxCutsPerSheet) {
    failures.push('cuts')
    details.push(
      `刀数太多：本张要切 ${cutCount} 刀，超过该设备单张最多 ${cutter.maxCutsPerSheet} 刀`,
    )
  }

  // —— 刀口太宽（只查内部共边刀；外侧修边刀落在废料上不受切缝限制）——
  const corridor = opts.kerfMm + opts.gapMm
  if (internalMeasures.length > 0 && cutter.bladeMm > corridor + EPS) {
    failures.push('blade')
    details.push(
      `刀口太宽：设备刀口 ${cutter.bladeMm}mm 大于排样为共边刀预留的切缝 ${corridor.toFixed(1)}mm（刀宽补偿 ${opts.kerfMm}mm + 隙距 ${opts.gapMm}mm），刀下去会啃进照片。回「新建任务」把刀宽补偿 / 隙距调到 ≥ ${cutter.bladeMm}mm 后重新排样，或换刀口更窄的设备`,
    )
  }

  const uniqFailures = Array.from(new Set(failures))
  if (uniqFailures.length === 0) {
    details.push(
      `可以裁：${cutCount} 刀，最长一刀 ${longestCutMm.toFixed(1)}mm，最窄成品条 ${
        isFinite(narrowestStripMm) ? narrowestStripMm.toFixed(1) : '—'
      }mm，均在设备能力内`,
    )
  }
  return {
    sheetIndex: sheet.index,
    ok: uniqFailures.length === 0,
    failures: uniqFailures,
    cutCount,
    longestCutMm: round(longestCutMm, 2),
    narrowestStripMm: isFinite(narrowestStripMm) ? round(narrowestStripMm, 2) : 0,
    narrowestEdgeMm: isFinite(narrowestEdgeMm) ? round(narrowestEdgeMm, 2) : 0,
    measures,
    details,
  }
}

/** 相同版面（刀序完全一致）的纸张张数，用于「一次压几层」的叠层建议 */
function identicalSheetGroups(sheets: Sheet[]): number[] {
  const sigOf = (s: Sheet): string =>
    s.cutSteps.map((c) => `${c.axis}${round(c.at, 2)}@${round(c.from, 2)}-${round(c.to, 2)}`).join('|')
  const groups = new Map<string, number>()
  for (const s of sheets) groups.set(sigOf(s), (groups.get(sigOf(s)) ?? 0) + 1)
  return [...groups.values()].filter((n) => n > 1)
}

function buildStackAdvice(sheets: Sheet[], cutter: Cutter, ok: boolean): string {
  if (!ok || cutter.maxLayers <= 1 || sheets.length <= 1) return ''
  const groups = identicalSheetGroups(sheets)
  if (!groups.length) return ''
  const maxBatch = Math.max(...groups)
  const layers = Math.min(cutter.maxLayers, maxBatch)
  return `其中有版面完全相同的纸张（最多 ${maxBatch} 张一叠），该设备单次可压 ${cutter.maxLayers} 层，可 ${layers} 张一叠同时下刀`
}

/** 一台设备对整个任务（多张相纸）的判定 */
export function judgeCutter(
  sheets: Sheet[],
  paper: Paper,
  opts: PackOptions,
  cutter: Cutter,
): CutterVerdict {
  const verdicts = sheets.map((s) => judgeSheet(s, paper, opts, cutter))
  const ok = verdicts.every((v) => v.ok)
  return {
    cutter,
    ok,
    sheets: verdicts,
    stackAdvice: buildStackAdvice(sheets, cutter, ok),
  }
}

/** 逐台判定，给出适合的机器清单（不适合的原因已写在各 verdict 里） */
export function judgeAllCutters(
  sheets: Sheet[],
  paper: Paper,
  opts: PackOptions,
  cutters: Cutter[],
): CutterVerdict[] {
  return cutters.map((c) => judgeCutter(sheets, paper, opts, c))
}

export interface PaperSuggestion {
  paper: Paper
  /** 换到这张纸后，该设备能否裁（不重新排样的纸面几何试算可能有误差，仅作建议） */
  feasible: boolean
  reason: string
}

/**
 * 改纸建议的候选规格（方向必须正确）：
 *  - 幅面超了：找更小、但仍在设备最小幅面以上的纸，重排后让纸面放得下；
 *  - 刀数太多：找更小的纸多排几张（每张刀数随之下降），同样需重排实测；
 *  - 条太窄 / 刀口太宽：由照片尺寸与切缝决定，换纸解决不了，返回空（UI 给操作建议）。
 * 候选是否真的可行由调用方拿 judgePaperOnCutter 重排实测确认。
 */
export function suggestPapers(
  current: Paper,
  cutter: Cutter,
  failures: CutterFailCode[],
  library: Paper[],
  limit = 3,
): PaperSuggestion[] {
  if (!failures.length) return []
  if (failures.includes('strip') || failures.includes('blade')) return []
  const wantSmaller = failures.includes('format') || failures.includes('cuts')
  const out: PaperSuggestion[] = []
  for (const p of library) {
    if (p.id === current.id) continue
    if (p.kind === 'roll') continue
    const fits = sheetFitsCutter(p.wMm, p.hMm, cutter)
    const aboveMin = sheetAboveMin(p.wMm, p.hMm, cutter)
    const smaller = p.wMm * p.hMm < current.wMm * current.hMm - EPS
    if (wantSmaller && fits && aboveMin && smaller) {
      out.push({
        paper: p,
        feasible: true,
        reason: failures.includes('format')
          ? `幅面 ${p.wMm}×${p.hMm}mm 在该设备能力内，换纸重排后即可裁`
          : `纸面更小、重排后用纸张数会增加，每张要切的刀数随之下降（仍以重排后的判定为准）`,
      })
    }
    if (out.length >= limit) break
  }
  return out
}

/** 换设备建议：从设备清单里挑这张方案能裁的其它机器 */
export function suggestCutters(
  verdicts: CutterVerdict[],
  currentCutterId: string,
): Cutter[] {
  return verdicts.filter((v) => v.ok && v.cutter.id !== currentCutterId).map((v) => v.cutter)
}

/** 一句话汇总不适合的原因（如「幅面超了 + 有条太窄」） */
export function failSummary(failures: CutterFailCode[]): string {
  return failures.map((f) => FAIL_LABEL[f]).join(' + ')
}

/** 排样试算：把任务在候选相纸上重排，返回该设备对新方案的判定（用于改纸建议的实测） */
export function judgePaperOnCutter(
  groups: import('./packer').PackGroup[],
  baseOpts: Omit<PackOptions, 'paperW' | 'paperH' | 'marginMm'>,
  candidate: Paper,
  cutter: Cutter,
): CutterVerdict | undefined {
  const out = pack(groups, {
    ...baseOpts,
    paperW: candidate.wMm,
    paperH: candidate.hMm,
    marginMm: candidate.marginMm,
  })
  if (out.error) return undefined
  const opts: PackOptions = {
    ...baseOpts,
    paperW: candidate.wMm,
    paperH: candidate.hMm,
    marginMm: candidate.marginMm,
  }
  return judgeCutter(out.result.sheets, candidate, opts, cutter)
}
