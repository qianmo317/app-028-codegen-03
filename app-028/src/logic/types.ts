/** 数据模型（对应规格书 §7） */

export type PaperKind = 'sheet' | 'roll'

export interface Paper {
  id: string
  name: string
  wMm: number
  hMm: number
  marginMm: number
  priceCents: number
  kind: PaperKind
}

export interface PhotoSize {
  id: string
  name: string
  wMm: number
  hMm: number
  rotateByDefault: boolean
}

/** 本机读取的照片文件信息（只读尺寸与方向，不上传） */
export interface PhotoRef {
  name: string
  wPx: number
  hPx: number
  landscape: boolean
}

export interface Item {
  id: string
  sizeId: string
  qty: number
  rotateAllowed: boolean
  /** true = 同一张照片重复排；false = 一张照片只出现一次（每张各需一张底片） */
  repeatSamePhoto: boolean
  /** true = 该尺寸的照片尽量不拆散，排在同一张相纸上 */
  keepTogether: boolean
  photo?: PhotoRef
}

/** 实际照片矩形（mm，含旋转后的宽高） */
export interface Placement {
  itemId: string
  sheetIndex: number
  x: number
  y: number
  w: number
  h: number
  rotated: boolean
  seq: number
}

export type CutAxis = 'v' | 'h'

/** 贯通切割线；axis='v' 时 at 为 x，from/to 为 y 区间 */
export interface CutStep {
  sheetIndex: number
  axis: CutAxis
  at: number
  from: number
  to: number
  /** 该步由共边合并而来 */
  merged: boolean
}

export interface Sheet {
  index: number
  placements: Placement[]
  cutSteps: CutStep[]
  /** 合并前的切割步数（用于共边合并的对比断言） */
  rawCutCount: number
  usedAreaMm2: number
  sheetAreaMm2: number
  utilization: number
  wasteRects: WasteRect[]
}

export interface WasteRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PackStats {
  totalPhotos: number
  sheets: number
  avgUtilization: number
  elapsedMs: number
  keepTogetherBroken: string[]
}

export interface PackResult {
  sheets: Sheet[]
  stats: PackStats
}

export interface CostReport {
  paperName: string
  sheets: number
  totalCents: number
  perPhotoCents: number
  totalPhotoCount: number
  /** 本方案浪费率 */
  wasteRate: number
  /** 不排样逐张打印的浪费率 */
  naiveWasteRate: number
  naiveTotalCents: number
  savedCents: number
}

export interface Task {
  id: string
  name: string
  paperId: string
  /** 自定义相纸（paperId 为 'custom' 时生效） */
  customPaper?: Paper
  items: Item[]
  gapMm: number
  kerfMm: number
  safeEdgeMm: number
  allowRotate: boolean
  headerText: string
  footerText: string
  createdAt: number
  /** 手工微调过的排样（存在时优先于自动排样结果） */
  manual?: {
    placements: Placement[]
    valid: boolean
    message: string
    validationMs: number
    stepCount: number
  }
  result?: PackResult
}

export interface Leftover {
  id: string
  name: string
  wMm: number
  hMm: number
  marginMm: number
  priceCents: number
  createdAt: number
  usedCount: number
}

export interface Settings {
  gapMm: number
  kerfMm: number
  safeEdgeMm: number
  allowRotate: boolean
  exportDpi: number
}

export interface PaperTemplate {
  id: string
  name: string
  paperId: string
  items: Array<{
    sizeId: string
    qty: number
    rotateAllowed: boolean
    keepTogether: boolean
  }>
}

/** 裁切设备类型：裁刀（手工滚轮刀）/ 铡刀（手动平压切纸机）/ 电动裁切机 */
export type CutterKind = 'roller' | 'guillotine' | 'electric'

/** 设备档案：每台机器能裁多大、能裁多窄的条、刀口多宽、一次能压几层 */
export interface Cutter {
  id: string
  name: string
  kind: CutterKind
  /** 最大可裁幅面（mm）：纸的宽/高均不得超过，允许把纸转 90° 上刀 */
  maxSheetWMm: number
  maxSheetHMm: number
  /** 最小可裁幅面（mm）：整张纸过小的话连压都压不住、无法下刀；0 = 不限 */
  minSheetWMm: number
  minSheetHMm: number
  /** 最小条宽（mm）：后挡规能定到的最窄位置，比这窄的条夹不住；0 = 不限 */
  minStripMm: number
  /** 刀口宽度（mm）：刀片本身的厚度，必须 ≤ 排样预留的刀宽补偿 kerf，否则会切进照片 */
  bladeMm: number
  /** 单次可裁层数：一次最多能压多少张相同版面；0 = 不限 */
  maxLayers: number
  /** 单张最多刀数：超过后定位累积误差不可接受（电动程控机按程序刀数）；0 = 不限 */
  maxCutsPerSheet: number
  /** 备注（老师傅经验） */
  note: string
  /** true = 店内内置设备（可编辑参数、可恢复出厂，不可删除） */
  builtin: boolean
}
