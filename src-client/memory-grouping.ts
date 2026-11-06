/**
 * memory-grouping — MemoryView 按日分组的纯函数核（从 MemoryView.tsx 拆出，
 * 便于脱离 react/CSS-Modules 导入链直接做单测）。
 */
import { t } from './i18n.ts'

interface MemoryItem { timestamp?: number; [key: string]: unknown }

export interface DayGroup {
  label: string
  items: MemoryItem[]
}

export function dayLabel(timestamp: number | undefined): string {
  if (timestamp === undefined) return t('time.dayUnknown')
  const date = new Date(timestamp)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay(date, today)) return t('time.today')
  if (sameDay(date, yesterday)) return t('time.yesterday')
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function groupByDay(items: MemoryItem[]): DayGroup[] {
  // 按 label 归并而非顺序追加：搜索态按分数排序，同一天条目可能不连续，
  // 顺序追加会产出多个同名分组（重复 React key）；浏览态时间有序，归并
  // 结果与原行为完全一致。
  const byLabel = new Map<string, DayGroup>()
  for (const item of items) {
    const label = dayLabel(item.timestamp)
    let group = byLabel.get(label)
    if (group === undefined) {
      group = { label, items: [] }
      byLabel.set(label, group)
    }
    group.items.push(item)
  }
  return [...byLabel.values()]
}
