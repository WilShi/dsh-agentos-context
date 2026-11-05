/**
 * 图谱懒加载 chunk（__dshChunks__["graph"]）：cytoscape + fcose/dagre 布局，
 * 全量 noExternal 打进 lib/client-graph.js（~500KB），首次打开图谱视图时经
 * /opencontext-api/bundle/graph.js 注入。无任何 external —— chunk 自给自足，
 * 不依赖宿主 seed（React 在 client.js 主包侧，chunk 只出 cytoscape）。
 */
import cytoscape from 'cytoscape'
import fcose from 'cytoscape-fcose'
import dagre from 'cytoscape-dagre'

cytoscape.use(fcose)
cytoscape.use(dagre)

export default cytoscape
