/**
 * 设备档案判定引擎：
 *  把排样方案的切割步骤逐刀重放，量出
 *    - 每一刀实际切多长（沿刀方向，受刀门/导轨长度限制）
 *    - 每一刀在刀线与相邻刀线/纸边之间夹出的「含照片条」有多窄（受后挡规最小定位限制）
 *    - 每张纸一共几刀（受单张刀数上限限制）
 *  再逐台机器按「幅面 / 最小条宽 / 刀数 / 刀口厚度」判定能不能裁，并给出改纸或换设备建议。
 */
import { EPS, type CutLine, type Rect } from './guillotine'
import { pack, type PackGroup, type PackOptions } from './packer'
import { round } from './units'
import type { Cutter, Paper, Sheet } from './types'

export type CutterFailKind = 'format' | 'strip' | 'cuts' | 'blade'

export interface CutterFail {
  kind: CutterFailKind
  message: string
}

export interface StepMetric {
  /** 这一刀沿刀方向的长度 mm */
  lengthMm: number
  /** 这一刀夹出的最窄「含照片条」宽度 mm（垂直于刀；null = 这一刀只修废边） */
  stripMm: number | null
}

export interface SheetCutAnalysis {
  sheetIndex: number
  /** 这张纸一共切几刀 */
  cutCount: number
  /** 最长的一刀切多长 */
  maxCutLength: number
  /** 最长一刀的序号（1-based） */
  longestStep: number
  /** 全部刀里最窄的含照片条宽 */
  narrowestStrip: number
  /** 最窄条出现在第几刀（1-based） */
  narrowestStep: number
  perStep: StepMetric[]
}

export interface SheetVerdict {
  sheetIndex: number
  ok: boolean
  fails: CutterFail[]
  analysis: SheetCutAnalysis
}

export interface LayerHint {
  /** 相同版面的纸（1-based 序号） */
  sheets: number[]
  /** 需要叠裁的总张数 */
  copies: number
  /** 本机单次最多压几层 */
  maxLayers: number
  /** 需要分几叠 */
  stacks: number
  ok: boolean
}

export interface CutterVerdict {
  cutter: Cutter
  ok: boolean
  sheetVerdicts: SheetVerdict[]
  /** 整单级失败（与单张无关，例如刀口太厚） */
  jobFails: CutterFail[]
  /** 改纸 / 改参数 / 换设备的建议 */
  suggestions: string[]
  layerHints: LayerHint[]
}

export interface JudgeContext {
  paper: Paper
  safeEdgeMm: number
  kerfMm: number
  gapMm: number
  sheets: Sheet[]
}

interface SimPiece {
  r: Rect
  idx: number[]
}

function passesThrough(p: SimPiece, c: CutLine): boolean {
  if (c.axis === 'v') {
    return (
      p.r.x < c.at - EPS &&
      c.at < p.r.x + p.r.w - EPS &&
      c.from <= p.r.y + EPS &&
      p.r.y + p.r.h <= c.to + EPS
    )
  }
  return (
    p.r.y < c.at - EPS &&
    c.at < p.r.y + p.r.h - EPS &&
    c.from <= p.r.x + EPS &&
    p.r.x + p.r.w <= c.to + EPS
  )
}

function regionOf(paper: Paper, safeEdgeMm: number): Rect {
  const inset = paper.marginMm + safeEdgeMm
  return { x: inset, y: inset, w: paper.wMm - 2 * inset, h: paper.hMm - 2 * inset }
}

function slotsOf(sheet: Sheet, kerfMm: number, gapMm: number): Rect[] {
  const m = (kerfMm + gapMm) / 2
  return sheet.placements.map((p) => ({
    x: p.x - m,
    y: p.y - m,
    w: p.w + 2 * m,
    h: p.h + 2 * m,
  }))
}

/**
 * 逐刀重放一张纸的切割序列。每切一刀，受影响的块被分成两个子块，
 * 两个子块在垂直于刀方向上的宽度就是「这一刀夹出来的条」；
 * 空块（废料边）不算——修掉的废边多窄都不影响机器。
 */
export function analyzeSheet(sheet: Sheet, ctx: JudgeContext): SheetCutAnalysis {
  const region = regionOf(ctx.paper, ctx.safeEdgeMm)
  const slots = slotsOf(sheet, ctx.kerfMm, ctx.gapMm)
  const cuts: CutLine[] = sheet.cutSteps.map((c) => ({
    axis: c.axis,
    at: c.at,
    from: c.from,
    to: c.to,
  }))

  let pieces: SimPiece[] = [{ r: { ...region }, idx: slots.map((_, i) => i) }]
  const perStep: StepMetric[] = []

  for (const c of cuts) {
    const affected = pieces.filter((p) => passesThrough(p, c))
    let stripMin = Infinity
    const next: SimPiece[] = []
    for (const p of affected) {
      let leftIdx: number[]
      let rightIdx: number[]
      let leftW: number
      let rightW: number
      if (c.axis === 'v') {
        leftIdx = p.idx.filter((i) => slots[i].x + slots[i].w <= c.at + EPS)
        rightIdx = p.idx.filter((i) => slots[i].x >= c.at - EPS)
        leftW = c.at - p.r.x
        rightW = p.r.x + p.r.w - c.at
        if (leftIdx.length) stripMin = Math.min(stripMin, leftW)
        if (rightIdx.length) stripMin = Math.min(stripMin, rightW)
        next.push({ r: { x: p.r.x, y: p.r.y, w: leftW, h: p.r.h }, idx: leftIdx })
        next.push({ r: { x: c.at, y: p.r.y, w: rightW, h: p.r.h }, idx: rightIdx })
      } else {
        leftIdx = p.idx.filter((i) => slots[i].y + slots[i].h <= c.at + EPS)
        rightIdx = p.idx.filter((i) => slots[i].y >= c.at - EPS)
        leftW = c.at - p.r.y
        rightW = p.r.y + p.r.h - c.at
        if (leftIdx.length) stripMin = Math.min(stripMin, leftW)
        if (rightIdx.length) stripMin = Math.min(stripMin, rightW)
        next.push({ r: { x: p.r.x, y: p.r.y, w: p.r.w, h: leftW }, idx: leftIdx })
        next.push({ r: { x: p.r.x, y: c.at, w: p.r.w, h: rightW }, idx: rightIdx })
      }
    }
    perStep.push({
      lengthMm: round(c.to - c.from, 2),
      stripMm: Number.isFinite(stripMin) ? round(stripMin, 2) : null,
    })
    pieces = [...pieces.filter((p) => !affected.includes(p)), ...next]
  }

  let maxCutLength = 0
  let longestStep = 0
  let narrowestStrip = Infinity
  let narrowestStep = 0
  perStep.forEach((m, i) => {
    if (m.lengthMm > maxCutLength) {
      maxCutLength = m.lengthMm
      longestStep = i + 1
    }
    if (m.stripMm !== null && m.stripMm < narrowestStrip) {
      narrowestStrip = m.stripMm
      narrowestStep = i + 1
    }
  })
  return {
    sheetIndex: sheet.index,
    cutCount: cuts.length,
    maxCutLength: round(maxCutLength, 2),
    longestStep,
    narrowestStrip: Number.isFinite(narrowestStrip) ? round(narrowestStrip, 2) : 0,
    narrowestStep,
    perStep,
  }
}

/** 纸张能否按某种转向上机（允许把纸转 90°） */
function dimsFit(w: number, h: number, maxW: number, maxH: number): boolean {
  return (w <= maxW + EPS && h <= maxH + EPS) || (w <= maxH + EPS && h <= maxW + EPS)
}

function judgeSheet(cutter: Cutter, a: SheetCutAnalysis, ctx: JudgeContext): SheetVerdict {
  const fails: CutterFail[] = []
  const { paper } = ctx
  const longSide = Math.max(cutter.maxSheetWMm, cutter.maxSheetHMm)

  // —— 幅面：整张纸上机（最大幅面、最小幅面）——
  if (!dimsFit(paper.wMm, paper.hMm, cutter.maxSheetWMm, cutter.maxSheetHMm)) {
    const needW = Math.max(paper.wMm, paper.hMm)
    const needH = Math.min(paper.wMm, paper.hMm)
    const over = round(
      Math.max(0, needW - longSide, needH - Math.min(cutter.maxSheetWMm, cutter.maxSheetHMm)),
      1,
    )
    fails.push({
      kind: 'format',
      message:
        `幅面超限：相纸 ${paper.wMm}×${paper.hMm}mm，本机最大 ${cutter.maxSheetWMm}×${cutter.maxSheetHMm}mm` +
        `（转 90° 也放不下，至少超 ${over}mm）`,
    })
  }
  const minW = cutter.minSheetWMm
  const minH = cutter.minSheetHMm
  if ((minW > 0 || minH > 0) && !dimsFitMin(paper.wMm, paper.hMm, minW, minH)) {
    fails.push({
      kind: 'format',
      message:
        `幅面过小：相纸 ${paper.wMm}×${paper.hMm}mm 小于本机最小可裁幅面 ${minW}×${minH}mm，压不住、无法下刀`,
    })
  }
  // —— 幅面：每一刀的长度不能超过刀门/导轨（切后各块只会比整纸更小，块深无需再查）——
  if (a.maxCutLength > longSide + EPS) {
    fails.push({
      kind: 'format',
      message: `第 ${a.longestStep} 刀长 ${a.maxCutLength}mm，超过本机刀门 ${longSide}mm`,
    })
  }

  // —— 最小条宽：相邻刀线夹出来的含照片条 ——
  if (cutter.minStripMm > 0 && a.narrowestStrip + EPS < cutter.minStripMm) {
    fails.push({
      kind: 'strip',
      message:
        `条太窄：第 ${a.narrowestStep} 刀与相邻刀线/纸边之间只夹出 ${a.narrowestStrip}mm 的含照片条，` +
        `本机后挡规最小只能定到 ${cutter.minStripMm}mm，窄条夹不住会跑偏`,
    })
  }

  // —— 刀数 ——
  if (cutter.maxCutsPerSheet > 0 && a.cutCount > cutter.maxCutsPerSheet) {
    fails.push({
      kind: 'cuts',
      message: `刀数太多：本张要切 ${a.cutCount} 刀，本机单张上限 ${cutter.maxCutsPerSheet} 刀`,
    })
  }

  return { sheetIndex: a.sheetIndex, ok: fails.length === 0, fails, analysis: a }
}

/** 纸张能否按某种转向上机（允许把纸转 90°）：最小幅面判定 */
function dimsFitMin(w: number, h: number, minW: number, minH: number): boolean {
  const a = Math.max(minW, 0)
  const b = Math.max(minH, 0)
  return (w + EPS >= a && h + EPS >= b) || (w + EPS >= b && h + EPS >= a)
}

/** 相同版面（切割步骤一致）的纸张归组，用于叠裁建议 */
export function layerGroups(sheets: Sheet[], maxLayers: number): LayerHint[] {
  if (maxLayers <= 0 || sheets.length < 2) return []
  const sigOf = (s: Sheet): string =>
    JSON.stringify(
      s.cutSteps.map((c) => [c.axis, round(c.at, 1), round(c.from, 1), round(c.to, 1)]),
    )
  const groups = new Map<string, number[]>()
  sheets.forEach((s) => {
    const k = sigOf(s)
    const g = groups.get(k)
    if (g) g.push(s.index)
    else groups.set(k, [s.index])
  })
  const hints: LayerHint[] = []
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue
    hints.push({
      sheets: idxs.map((i) => i + 1),
      copies: idxs.length,
      maxLayers,
      stacks: Math.ceil(idxs.length / maxLayers),
      ok: idxs.length <= maxLayers,
    })
  }
  return hints
}

/** 逐台判定：一台机器只有「每张纸都能裁 + 整单级检查通过」才算适合 */
export function judgeCutter(cutter: Cutter, ctx: JudgeContext): CutterVerdict {
  const analyses = ctx.sheets.map((s) => analyzeSheet(s, ctx))
  const sheetVerdicts = analyses.map((a) => judgeSheet(cutter, a, ctx))

  const jobFails: CutterFail[] = []
  const reserve = round(ctx.kerfMm + ctx.gapMm, 3)
  if (cutter.bladeMm > reserve + EPS) {
    jobFails.push({
      kind: 'blade',
      message:
        `刀口太厚：本机刀口 ${cutter.bladeMm}mm，本方案只预留 ${reserve}mm（刀宽补偿 kerf ${ctx.kerfMm} + 隙距 ${ctx.gapMm}），` +
        `硬裁会切进照片`,
    })
  }

  const suggestions: string[] = []
  const kinds = new Set([
    ...jobFails.map((f) => f.kind),
    ...sheetVerdicts.flatMap((v) => v.fails.map((f) => f.kind)),
  ])
  if (kinds.has('format')) {
    suggestions.push(
      `改纸：换成幅面不超过 ${cutter.maxSheetWMm}×${cutter.maxSheetHMm}mm、不小于 ${cutter.minSheetWMm}×${cutter.minSheetHMm}mm 的相纸（用下方「换纸重排」试算）；或换更大刀门的设备`,
    )
  }
  if (kinds.has('strip')) {
    suggestions.push(
      `改摆位/改纸：重排让相邻刀线间距 ≥ ${cutter.minStripMm}mm（减小安全边修边量、避免窄长条）；或换最小条宽更小的设备`,
    )
  }
  if (kinds.has('cuts')) {
    suggestions.push(
      `减少刀数：增大照片尺寸/间隙让共边合并更多刀，或分到更多张纸上；也可换无单张刀数限制的设备`,
    )
  }
  if (kinds.has('blade')) {
    suggestions.push(
      `把本任务的刀宽补偿 kerf 调到 ≥ ${cutter.bladeMm}mm 后重新排样（排样页/新建任务页可改），或换刀口更薄的机器`,
    )
  }

  return {
    cutter,
    ok: sheetVerdicts.every((v) => v.ok) && jobFails.length === 0,
    sheetVerdicts,
    jobFails,
    suggestions,
    layerHints: layerGroups(ctx.sheets, cutter.maxLayers),
  }
}

export function judgeAll(cutters: Cutter[], ctx: JudgeContext): CutterVerdict[] {
  return cutters.map((c) => judgeCutter(c, ctx))
}

export interface PaperSuggestion {
  paper: Paper
  sheetCount: number
  verdict: CutterVerdict
}

/**
 * 换纸建议：在给定设备上把各种相纸重新排一遍样，
 * 只返回「这台机器真能裁」的纸，按用纸张数排序。
 */
export function suggestPapersForCutter(
  cutter: Cutter,
  groups: PackGroup[],
  base: Omit<PackOptions, 'paperW' | 'paperH' | 'marginMm'>,
  papers: Paper[],
): PaperSuggestion[] {
  const out: PaperSuggestion[] = []
  for (const paper of papers) {
    if (paper.kind === 'roll') continue
    if (!dimsFit(paper.wMm, paper.hMm, cutter.maxSheetWMm, cutter.maxSheetHMm)) continue
    if (!dimsFitMin(paper.wMm, paper.hMm, cutter.minSheetWMm, cutter.minSheetHMm)) continue
    const r = pack(groups, { ...base, paperW: paper.wMm, paperH: paper.hMm, marginMm: paper.marginMm })
    if (r.error) continue
    const v = judgeCutter(cutter, {
      paper,
      safeEdgeMm: base.safeEdgeMm,
      kerfMm: base.kerfMm,
      gapMm: base.gapMm,
      sheets: r.result.sheets,
    })
    if (v.ok) out.push({ paper, sheetCount: r.result.sheets.length, verdict: v })
  }
  return out.sort((a, b) => a.sheetCount - b.sheetCount || a.paper.wMm * a.paper.hMm - b.paper.wMm * b.paper.hMm)
}

export const CUTTER_KIND_LABEL: Record<Cutter['kind'], string> = {
  roller: '手工裁刀',
  guillotine: '铡刀',
  electric: '电动裁切机',
}

/** 判定失败类别 -> 中文短语（徽标用） */
export const FAIL_KIND_LABEL: Record<CutterFailKind, string> = {
  format: '幅面',
  strip: '条太窄',
  cuts: '刀数太多',
  blade: '刀口太厚',
}
