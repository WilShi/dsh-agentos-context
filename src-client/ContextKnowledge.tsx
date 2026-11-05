import React, { useRef, useState } from 'react'
import { Button, Tag } from './ui-primitives.tsx'
import type { ContextApi } from './context-api.ts'
import type { ContextDocument, ContextDocumentChunk, ContextDocumentHit } from './context-types.ts'
import { ContextModal } from './ContextModal.tsx'
import {
  formatTime,
  plainError,
  useLoad,
  useMutationGuard,
} from './context-ui-helpers.tsx'
import styles from './Context.module.css'

const MAX_TEXT_FILE_BYTES = 4 * 1024 * 1024
const MAX_BINARY_FILE_BYTES = 25 * 1024 * 1024
const ACCEPT =
  '.txt,.md,.markdown,.html,.htm,.csv,.json,.jsonl,.xml,.yaml,.yml,.log,.js,.jsx,.ts,.tsx,.css,.sql,.py,.java,.c,.h,.cpp,.go,.rs,.sh,.ps1,.docx,.xlsx,.pptx,.pdf,.odt,.ods,.odp,.odg,.rtf,.epub,text/*,application/json,application/xml,application/pdf,application/rtf,application/epub+zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.oasis.opendocument.text,application/vnd.oasis.opendocument.spreadsheet,application/vnd.oasis.opendocument.presentation'
const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'markdown',
  'html',
  'htm',
  'csv',
  'json',
  'jsonl',
  'xml',
  'yaml',
  'yml',
  'log',
  'js',
  'jsx',
  'ts',
  'tsx',
  'css',
  'sql',
  'py',
  'java',
  'c',
  'h',
  'cpp',
  'go',
  'rs',
  'sh',
  'ps1',
])
const isTextFile = (file: File) =>
  file.type.startsWith('text/') ||
  ['application/json', 'application/xml'].includes(file.type) ||
  TEXT_EXTENSIONS.has(file.name.split('.').pop()?.toLowerCase() ?? '')

const BINARY_EXTENSIONS = new Set([
  'docx',
  'xlsx',
  'pptx',
  'pdf',
  'odt',
  'ods',
  'odp',
  'odg',
  'rtf',
  'epub',
])
const extensionOf = (file: File) =>
  file.name.split('.').pop()?.toLowerCase() ?? ''

function readAsBase64(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const abort = () => reader.abort()
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
    reader.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    reader.onload = () => {
      signal.removeEventListener('abort', abort)
      if (typeof reader.result !== 'string') {
        reject(new Error('读取文件失败'))
        return
      }
      const separator = reader.result.indexOf(',')
      if (separator < 0) {
        reject(new Error('读取文件失败'))
        return
      }
      resolve(reader.result.slice(separator + 1))
    }
    reader.readAsDataURL(file)
  })
}

export function ContextKnowledge({
  api,
  scopeId,
  writeScopeId = scopeId,
}: {
  api: ContextApi
  scopeId: string
  writeScopeId?: string
}) {
  const runMutation = useMutationGuard(writeScopeId),
    picker = useRef<HTMLInputElement>(null)
  const documents = useLoad(api, 'documents:' + scopeId, s =>
    api.documents(scopeId, 200, s),
  )
  const [query, setQuery] = useState(''),
    [submitted, setSubmitted] = useState(''),
    [searchMode, setSearchMode] = useState<'hybrid'|'semantic'|'keyword'>('hybrid'),
    [threshold, setThreshold] = useState(0.25),
    [resultLimit, setResultLimit] = useState(20),
    [documentFilter, setDocumentFilter] = useState(''),
    [busy, setBusy] = useState(false),
    [dragging, setDragging] = useState(false),
    [uploadProgress, setUploadProgress] = useState<{ done:number;total:number;current:string }|null>(null),
    [notice, setNotice] = useState(''),
    [error, setError] = useState(''),
    [selectedIds, setSelectedIds] = useState<Set<string>>(new Set()),
    [pendingDelete, setPendingDelete] = useState<ContextDocument | null>(null),
    [pendingBatchDelete, setPendingBatchDelete] = useState(false),
    [detail, setDetail] = useState<{ document:ContextDocument;chunks:ContextDocumentChunk[] }|{ hit:ContextDocumentHit }|null>(null),
    [detailBusy, setDetailBusy] = useState(false)
  const hits = useLoad(
    api,
    ['document-search',scopeId,submitted,searchMode,threshold,resultLimit,documentFilter].join(':'),
    s =>
      submitted
        ? api.searchDocuments(
          scopeId,
          submitted,
          { limit: resultLimit, threshold, searchMode, ...(documentFilter?{ documentIds:[documentFilter] }:{}) },
          s,
        )
        : Promise.resolve([]),
  )
  const choose = () => { if (!busy) picker.current?.click() }
  const uploadFiles = async (files: File[]) => {
    if (!files.length || busy) return
    setError('')
    setNotice('')
    setBusy(true)
    setUploadProgress({ done: 0, total: files.length, current: files[0]?.name ?? '' })
    try {
      const results = await runMutation(async (signal) => {
        const uploaded: { file:File;out:Awaited<ReturnType<ContextApi['uploadDocument']>> }[] = []
        const failed: { file:File;message:string }[] = []
        for (const [index, file] of files.entries()) {
          setUploadProgress({ done: index, total: files.length, current: file.name })
          const textFile = isTextFile(file)
          const binaryFile = BINARY_EXTENSIONS.has(extensionOf(file))
          const validationError = !textFile && !binaryFile
            ? '不支持该文件格式'
            : file.size > (textFile ? MAX_TEXT_FILE_BYTES : MAX_BINARY_FILE_BYTES)
              ? textFile ? '文本文件超过 4 MB' : '二进制文档超过 25 MB'
              : ''
          if (validationError) {
            failed.push({ file, message: validationError })
            setUploadProgress({ done: index + 1, total: files.length, current: file.name })
            continue
          }
          try {
            const payload = textFile
              ? { content: await file.text() }
              : { dataBase64: await readAsBase64(file, signal) }
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
            const out = await api.uploadDocument(
              {
                scopeId: writeScopeId,
                filename: file.name,
                mimeType:
                  file.type ||
                  (textFile ? 'text/plain' : 'application/octet-stream'),
                ...payload,
                metadata: { source: 'workbench-upload' },
              },
              signal,
            )
            uploaded.push({ file, out })
          } catch (uploadError) {
            if ((uploadError as Error).name === 'AbortError') throw uploadError
            failed.push({ file, message: plainError(uploadError) })
          }
          setUploadProgress({ done: index + 1, total: files.length, current: file.name })
        }
        return { uploaded, failed }
      })
      const semanticPending = results.uploaded.filter(({ out }) => out.semanticPending).length
      if (files.length === 1 && results.uploaded.length === 1) {
        const uploaded = results.uploaded[0]
        if (!uploaded) throw new Error('upload result missing')
        const { file, out } = uploaded
        const parsedFormat = out.sourceFormat?.toUpperCase() ?? extensionOf(file).toUpperCase() ?? '文档'
        const warnings = out.warningCodes ?? []
        setNotice(`已上传 ${file.name}（${parsedFormat}），建立 ${out.chunks} 个检索片段${out.semanticPending ? '；关键词检索已可用，语义索引将在密钥可用后自动补建' : '，语义索引已就绪'}${warnings.length ? `；解析提示：${warnings.join('、')}` : ''}。`)
      } else {
        setNotice(`已处理 ${files.length}/${files.length}：成功 ${results.uploaded.length} 篇，失败 ${results.failed.length} 篇${semanticPending ? `；${semanticPending} 篇等待补建语义索引` : ''}。`)
      }
      if (results.failed.length) setError(results.failed.map(({ file,message }) => `${file.name}：${message}`).join('；'))
      if (results.uploaded.length) documents.reload()
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(plainError(e))
    } finally {
      setBusy(false)
      setDragging(false)
      setUploadProgress(null)
    }
  }
  const upload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    void uploadFiles(files)
  }
  const drop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    if (!busy) void uploadFiles(Array.from(event.dataTransfer.files ?? []))
  }
  const remove = async () => {
    if (!pendingDelete || busy) return
    setBusy(true)
    setError('')
    try {
      const deleted = await runMutation(signal =>
        api.deleteDocument(pendingDelete.scopeId, pendingDelete.id, signal),
      )
      setNotice(
        deleted
          ? `已删除 ${pendingDelete.filename}。`
          : '文档已不存在，无需重复删除。',
      )
      setPendingDelete(null)
      setSelectedIds((current)=>{const next=new Set(current);next.delete(pendingDelete.id);return next})
      setSubmitted('')
      documents.reload()
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(plainError(e))
    } finally {
      setBusy(false)
    }
  }
  const openDocument = async (doc:ContextDocument) => {
    setDetailBusy(true);setError('')
    try {
      const out=await runMutation(signal=>api.documentChunks(doc.scopeId,doc.id,signal))
      setDetail({ document:out.document??doc,chunks:out.chunks })
    }
    catch(e){if((e as Error).name!=='AbortError')setError(plainError(e))}
    finally{setDetailBusy(false)}
  }
  const reindex = async (doc:ContextDocument) => {
    if(busy)return;setBusy(true);setError('');setNotice('')
    try{const out=await runMutation(signal=>api.reindexDocument(doc.scopeId,doc.id,signal));setNotice(out.reindexed?`已重建 ${doc.filename} 的 ${out.chunks} 个检索片段${out.semanticPending?'；关键词索引可用，语义索引等待密钥恢复':'，语义索引已就绪'}。`:`${doc.filename} 已不存在。`);hits.reload();documents.reload()}
    catch(e){if((e as Error).name!=='AbortError')setError(plainError(e))}
    finally{setBusy(false)}
  }
  const removeSelected = async () => {
    if(busy||!selectedIds.size)return;setBusy(true);setError('')
    try{
      const byScope=new Map<string,string[]>()
      for(const doc of documents.data??[])if(selectedIds.has(doc.id)){
        const ids=byScope.get(doc.scopeId)??[]
        ids.push(doc.id);byScope.set(doc.scopeId,ids)
      }
      let deleted=0,requested=0
      for(const [targetScope,ids] of byScope){
        const out=await runMutation(signal=>api.deleteDocuments(targetScope,ids,signal))
        deleted+=out.deleted;requested+=out.requested
      }
      setNotice(`已删除 ${deleted}/${requested} 篇知识库文档及其索引。`);setSelectedIds(new Set());setPendingBatchDelete(false);setSubmitted('');documents.reload()
    }catch(e){if((e as Error).name!=='AbortError')setError(plainError(e))}
    finally{setBusy(false)}
  }
  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <div className={styles.between}>
          <div>
            <h3 className={styles.sectionTitle}>知识库文档</h3>
            <p className={styles.hint}>
              知识库在所有工作区共享；上传后自动分块并建立语义索引，供检索与回答引用。
            </p>
          </div>
          <div className={styles.actions}>
            <input
              ref={picker}
              className={styles.srOnly}
              type="file"
              aria-label="选择知识库文件"
              accept={ACCEPT}
              multiple
              onChange={event => void upload(event)}
            />
            <Button variant="primary" disabled={busy} onClick={choose}>
              {busy ? '处理中…' : '上传文档'}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={documents.reload}
            >
              刷新
            </Button>
          </div>
        </div>
        <div
          className={`${styles.knowledgeDropZone} ${dragging ? styles.knowledgeDropZoneActive : ''}`}
          role="button"
          tabIndex={busy ? -1 : 0}
          aria-label="拖放上传知识库文件"
          aria-disabled={busy}
          onClick={choose}
          onKeyDown={(event) => { if (!busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); choose() } }}
          onDragEnter={(event) => { event.preventDefault(); if (!busy) setDragging(true) }}
          onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true) }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
          onDrop={drop}
        >
          <strong>{busy ? '正在整理文档…' : '拖放一篇或多篇文档到这里'}</strong>
          <span>{busy ? '请稍候，失败的文件不会影响其他文件' : '也可以点击这里选择文件；支持常用文本、Office、PDF 与 ODF 格式'}</span>
        </div>
        {uploadProgress && (
          <div className={styles.knowledgeUploadProgress} role="status" aria-live="polite">
            <div><span>正在处理 {uploadProgress.current}</span><strong>{uploadProgress.done}/{uploadProgress.total}</strong></div>
            <progress value={uploadProgress.done} max={uploadProgress.total} />
          </div>
        )}
        <details className={styles.knowledgeFormats}>
          <summary>支持格式与大小限制</summary>
          <p>
            TXT、Markdown、HTML、CSV、JSON、YAML、XML 和常见源码最大 4 MB；
            DOCX、XLSX、PPTX、PDF、ODT、ODS、ODP、ODG、RTF、EPUB 最大 25 MB。
            WPS 可先另存为 DOCX、XLSX、PPTX 或 ODF；暂不支持旧版 DOC、XLS、PPT
            及 WPS 专有格式。
          </p>
        </details>
      </section>
      {notice && (
        <div className={styles.notice} role="status">
          {notice}
        </div>
      )}
      {error && (
        <div className={styles.errorText} role="alert">
          {error}
        </div>
      )}
      <div className={styles.toolbar}>
        <input
          aria-label="搜索知识库"
          value={query}
          onChange={e => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setSubmitted(query.trim())
          }}
          placeholder="输入内容进行语义检索"
        />
        <select aria-label="检索方式" value={searchMode} onChange={e=>setSearchMode(e.currentTarget.value as typeof searchMode)}>
          <option value="hybrid">混合检索（推荐）</option>
          <option value="semantic">仅语义</option>
          <option value="keyword">仅关键词</option>
        </select>
        <select aria-label="限定文档" value={documentFilter} onChange={e=>setDocumentFilter(e.currentTarget.value)}>
          <option value="">全部文档</option>
          {(documents.data??[]).map(doc=><option key={doc.scopeId+doc.id} value={doc.id}>{doc.filename}</option>)}
        </select>
        <select aria-label="结果数量" value={resultLimit} onChange={e=>setResultLimit(Number(e.currentTarget.value))}>
          <option value={5}>5 条</option><option value={10}>10 条</option><option value={20}>20 条</option><option value={50}>50 条</option>
        </select>
        <label className={styles.searchTuning}>最低相关度 {Math.round(threshold*100)}% <input aria-label="最低相关度" type="range" min="0" max="0.9" step="0.05" value={threshold} onChange={e=>setThreshold(Number(e.currentTarget.value))}/></label>
        <Button
          variant="outline"
          disabled={!query.trim() || busy}
          onClick={() => setSubmitted(query.trim())}
        >
          检索
        </Button>
        {submitted && (
          <Button
            variant="ghost"
            onClick={() => {
              setSubmitted('')
              setQuery('')
            }}
          >
            清除结果
          </Button>
        )}
      </div>
      <div className={styles.knowledgeStatus}>
        <div><strong>{documents.data?.length ?? 0}</strong><span>篇文档</span></div>
        <div><strong>{documents.data?.reduce((total, item) => total + item.chunks, 0) ?? 0}</strong><span>个检索片段</span></div>
        <div><strong>{submitted ? (hits.data?.length ?? 0) : '—'}</strong><span>条当前命中</span></div>
      </div>
      {submitted ? (
        <section className={styles.list} aria-label="知识库检索结果">
          {hits.phase === 'loading' ? (
            <div className={styles.loading}>正在检索知识库…</div>
          ) : hits.error ? (
            <div className={styles.error} role="alert">
              {hits.error}
              <Button onClick={hits.reload}>重试</Button>
            </div>
          ) : !hits.data?.length ? (
            <div className={styles.empty}>没有找到相关文档片段。</div>
          ) : (
            hits.data.map(hit => (
              <article className={styles.item} key={hit.id}>
                <div className={styles.between}>
                  <div className={styles.itemTitle}>{hit.documentName}</div>
                  <Tag tone="info">相关度 {Math.round(hit.score * 100)}%</Tag>
                </div>
                <p className={styles.source}>{hit.content}</p>
                <div className={styles.meta}>
                  片段 {hit.chunkIndex + 1} · {hit.documentId}
                </div>
                <div className={styles.actions}>
                  <Tag tone="outline">{Array.isArray(hit.metadata?.searchModes)?(hit.metadata.searchModes as string[]).join(' + '):searchMode}</Tag>
                  <Button size="sm" variant="ghost" onClick={()=>setDetail({ hit })}>查看证据</Button>
                </div>
              </article>
            ))
          )}
        </section>
      ) : (
        <section className={styles.list} aria-label="知识库文档列表">
          {!!documents.data?.length&&<div className={styles.item}>
            <div className={styles.between}><label className={styles.inline}><input type="checkbox" aria-label="选择全部文档" checked={selectedIds.size===documents.data.length} onChange={(e)=>{const checked=e.currentTarget.checked;setSelectedIds(checked?new Set(documents.data!.map(doc=>doc.id)):new Set())}}/>选择全部</label><Button size="sm" variant="outline" disabled={!selectedIds.size||busy} onClick={()=>setPendingBatchDelete(true)}>删除所选（{selectedIds.size}）</Button></div>
          </div>}
          {documents.phase === 'loading' ? (
            <div className={styles.loading}>正在读取知识库…</div>
          ) : documents.error ? (
            <div className={styles.error} role="alert">
              {documents.error}
            </div>
          ) : !documents.data?.length ? (
            <div className={styles.empty}>当前范围还没有文档。</div>
          ) : (
            documents.data.map(doc => (
              <article className={styles.item} key={doc.id}>
                <div className={styles.between}>
                  <div className={styles.inline}>
                    <input type="checkbox" aria-label={`选择 ${doc.filename}`} checked={selectedIds.has(doc.id)} onChange={(e)=>{const checked=e.currentTarget.checked;setSelectedIds((current)=>{const next=new Set(current);if(checked)next.add(doc.id);else next.delete(doc.id);return next})}}/>
                    <div>
                      <div className={styles.itemTitle}>{doc.filename}</div>
                      <div className={styles.badges}>
                        <Tag tone="neutral">{doc.mimeType}</Tag>
                        <Tag tone="outline">{doc.chunks} 个片段</Tag>
                        <Tag tone={doc.semanticPending ? 'warning' : doc.semanticIndexed ? 'success' : 'neutral'}>{doc.semanticPending ? '语义索引待补建' : doc.semanticIndexed ? '语义索引就绪' : '索引状态待确认'}</Tag>
                        <span className={styles.meta}>
                          {formatTime(doc.uploadedAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className={styles.actions}>
                    <Button size="sm" variant="ghost" disabled={busy||detailBusy} onClick={()=>void openDocument(doc)}>查看分块</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={()=>void reindex(doc)}>重建索引</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPendingDelete(doc)}>删除</Button>
                  </div>
                </div>
              </article>
            ))
          )}
        </section>
      )}
      <ContextModal
        size="compact"
        open={!!pendingDelete}
        onClose={() => !busy && setPendingDelete(null)}
        title="删除知识库文档"
        description="文档正文、分块和语义向量都会删除，此操作不能撤销。"
        closeLabel="关闭"
        footer={
          <div className={styles.actions}>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setPendingDelete(null)}
            >
              取消
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? '删除中…' : '确认删除'}
            </Button>
          </div>
        }
      >
        <p className={styles.modalContent}>
          确定删除“{pendingDelete?.filename}”吗？
        </p>
      </ContextModal>
      <ContextModal
        size="compact"
        open={pendingBatchDelete}
        onClose={()=>!busy&&setPendingBatchDelete(false)}
        title="批量删除知识库文档"
        description="所选文档、分块、关键词索引和语义向量都会删除。"
        closeLabel="关闭"
        footer={<div className={styles.actions}><Button variant="ghost" disabled={busy} onClick={()=>setPendingBatchDelete(false)}>取消</Button><Button variant="primary" disabled={busy} onClick={()=>void removeSelected()}>{busy?'删除中…':`确认删除 ${selectedIds.size} 篇`}</Button></div>}
      ><p className={styles.modalContent}>此操作不能撤销，请确认所选文档不再需要。</p></ContextModal>
      <ContextModal
        open={detail!==null}
        onClose={()=>setDetail(null)}
        title={detail&&'hit' in detail?`检索证据 · ${detail.hit.documentName}`:detail&&'document' in detail?detail.document.filename:'文档详情'}
        description={detail&&'hit' in detail?`片段 ${detail.hit.chunkIndex+1} · 相关度 ${Math.round(detail.hit.score*100)}%`:detail&&'document' in detail?`${detail.document.chunks} 个检索片段 · ${detail.document.scopeId}`:undefined}
        closeLabel="关闭"
        footer={<Button variant="primary" onClick={()=>setDetail(null)}>完成</Button>}
      >
        <div className={styles.modalContent}>
          {detail&&'hit' in detail?<><p className={styles.source}>{detail.hit.content}</p><pre className={styles.source}>{JSON.stringify(detail.hit.metadata,null,2)}</pre></>:detail&&'document' in detail?<div className={styles.stack}>{detail.chunks.map(chunk=><article key={chunk.id} className={styles.panel}><div className={styles.between}><strong>片段 {chunk.chunkIndex+1}</strong><span className={styles.meta}>{chunk.id}</span></div><p className={styles.source}>{chunk.content}</p></article>)}</div>:null}
        </div>
      </ContextModal>
    </div>
  )
}
