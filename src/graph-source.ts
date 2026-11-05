/**
 * graph-source — /opencontext-api/graph 的生产数据源：
 * 以 better-sqlite3 readonly 直读 memory store.db 与 dsh-knowledge.db
 * （路径与 knowledge-store/doctor 同约定，受 OPENCONTEXT_HOME 控制），
 * 每次请求独立开闭连接（只读、无锁竞争，免去跨路由的连接生命周期管理）。
 */
import { existsSync } from 'node:fs'
import Database from 'better-sqlite3'
import { getOpenContextPath } from '@melandlabs/env-config'
import { buildGraph, type GraphBuilderOptions, type GraphData } from './graph-builder.ts'

export function createGraphSource() {
  return (options: GraphBuilderOptions): GraphData => {
    const days = options.days ?? 30
    const memoryPath = getOpenContextPath('memory', 'store.db')
    if (!existsSync(memoryPath)) {
      return { nodes: [], edges: [], stats: { truncated: false, windowDays: days, nodeCount: 0, edgeCount: 0 } }
    }
    const knowledgePath = getOpenContextPath('dsh-knowledge.db')
    const memoryDb = new Database(memoryPath, { readonly: true })
    try {
      const knowledgeDb = existsSync(knowledgePath) ? new Database(knowledgePath, { readonly: true }) : undefined
      try {
        return buildGraph(memoryDb, knowledgeDb, options)
      } finally {
        knowledgeDb?.close()
      }
    } finally {
      memoryDb.close()
    }
  }
}
