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
import { t } from './i18n.ts'

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
    reader.onerror = () => reject(reader.error ?? new Error(t('knowledge.readFileFailed')))
    reader.onabort = () => reject(new DOMException('Aborted', 'AbortError'))
    reader.onload = () => {
      signal.removeEventListener('abort', abort)
      if (typeof reader.result !== 'string') {
        reject(new Error(t('knowledge.readFileFailed')))
        return
      }
      const separator = reader.result.indexOf(',')
      if (separator < 0) {
        reject(new Error(t('knowledge.readFileFailed')))
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
            ? t('knowledge.unsupportedFormat')
            : file.size > (textFile ? MAX_TEXT_FILE_BYTES : MAX_BINARY_FILE_BYTES)
              ? textFile ? t('knowledge.textTooLarge') : t('knowledge.binaryTooLarge')
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
        const parsedFormat = out.sourceFormat?.toUpperCase() ?? extensionOf(file).toUpperCase() ?? t('knowledge.formatFallback')
        const warnings = out.warningCodes ?? []
        setNotice(t('knowledge.notice.uploaded', { name: file.name, format: parsedFormat, chunks: out.chunks, semantic: out.semanticPending ? t('knowledge.notice.semanticPending') : t('knowledge.notice.semanticReady'), warnings: warnings.length ? t('knowledge.notice.warnings', { warnings: warnings.join(t('common.enumSeparator')) }) : '' }))
      } else {
        setNotice(t('knowledge.notice.batch', { total: files.length, uploaded: results.uploaded.length, failed: results.failed.length, semantic: semanticPending ? t('knowledge.notice.batchPending', { count: semanticPending }) : '' }))
      }
      if (results.failed.length) setError(results.failed.map(({ file,message }) => `${file.name}：${message}`).join(t('common.listSeparator')))
      if (results.uploaded.length) documents.reload()
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError(plainError(e))
    } finally {
      setBusy(false)
      setDragging(false)
      setUploadProgress(null)
    }
  }
  // M7: uploadFiles already reports progress/failures itself; this helper keeps
  // the fire-and-forget call sites from ever producing an unhandled rejection
  // (AbortError included, e.g. the view unmounts mid-upload).
  const startUpload = (files: readonly File[]) => {
    void uploadFiles([...files]).catch(error => {
      if ((error as Error | undefined)?.name !== 'AbortError')
        setError(plainError(error))
    })
  }
  const upload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? []) as File[]
    event.currentTarget.value = ''
    startUpload(files)
  }
  const drop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    if (!busy) startUpload(Array.from(event.dataTransfer.files ?? []) as File[])
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
          ? t('knowledge.notice.deleted', { name: pendingDelete.filename })
          : t('knowledge.notice.alreadyGone'),
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
    try{const out=await runMutation(signal=>api.reindexDocument(doc.scopeId,doc.id,signal));setNotice(out.reindexed?t('knowledge.notice.reindexed',{name:doc.filename,chunks:out.chunks,semantic:out.semanticPending?t('knowledge.notice.reindexPending'):t('knowledge.notice.semanticReady')}):t('knowledge.notice.reindexGone',{name:doc.filename}));hits.reload();documents.reload()}
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
      setNotice(t('knowledge.notice.batchDeleted',{deleted,requested}));setSelectedIds(new Set());setPendingBatchDelete(false);setSubmitted('');documents.reload()
    }catch(e){if((e as Error).name!=='AbortError')setError(plainError(e))}
    finally{setBusy(false)}
  }
  return (
    <div className={styles.stack}>
      <section className={styles.panel}>
        <div className={styles.between}>
          <div>
            <h3 className={styles.sectionTitle}>{t('knowledge.title.documents')}</h3>
            <p className={styles.hint}>
              {t('knowledge.hint.shared')}
            </p>
          </div>
          <div className={styles.actions}>
            <input
              ref={picker}
              className={styles.srOnly}
              type="file"
              aria-label={t('aria.selectFiles')}
              accept={ACCEPT}
              multiple
              onChange={event => void upload(event)}
            />
            <Button variant="primary" disabled={busy} onClick={choose}>
              {busy ? t('knowledge.action.uploading') : t('knowledge.action.upload')}
            </Button>
            <Button
              variant="outline"
              disabled={busy}
              onClick={documents.reload}
            >
              {t('common.refresh')}
            </Button>
          </div>
        </div>
        <div
          className={`${styles.knowledgeDropZone} ${dragging ? styles.knowledgeDropZoneActive : ''}`}
          role="button"
          tabIndex={busy ? -1 : 0}
          aria-label={t('aria.dropFiles')}
          aria-disabled={busy}
          onClick={choose}
          onKeyDown={(event) => { if (!busy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); choose() } }}
          onDragEnter={(event) => { event.preventDefault(); if (!busy) setDragging(true) }}
          onDragOver={(event) => { event.preventDefault(); if (!busy) setDragging(true) }}
          onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
          onDrop={drop}
        >
          <strong>{busy ? t('knowledge.drop.titleBusy') : t('knowledge.drop.title')}</strong>
          <span>{busy ? t('knowledge.drop.bodyBusy') : t('knowledge.drop.body')}</span>
        </div>
        {uploadProgress && (
          <div className={styles.knowledgeUploadProgress} role="status" aria-live="polite">
            <div><span>{t('knowledge.progress', { name: uploadProgress.current })}</span><strong>{uploadProgress.done}/{uploadProgress.total}</strong></div>
            <progress value={uploadProgress.done} max={uploadProgress.total} />
          </div>
        )}
        <details className={styles.knowledgeFormats}>
          <summary>{t('knowledge.formatLimit.summary')}</summary>
          <p>
            {t('knowledge.formatLimit.body')}
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
          aria-label={t('aria.searchKnowledge')}
          value={query}
          onChange={e => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setSubmitted(query.trim())
          }}
          placeholder={t('knowledge.search.placeholder')}
        />
        <select aria-label={t('aria.searchMode')} value={searchMode} onChange={e=>setSearchMode(e.currentTarget.value as typeof searchMode)}>
          <option value="hybrid">{t('knowledge.search.hybrid')}</option>
          <option value="semantic">{t('knowledge.search.semantic')}</option>
          <option value="keyword">{t('knowledge.search.keyword')}</option>
        </select>
        <select aria-label={t('aria.documentFilter')} value={documentFilter} onChange={e=>setDocumentFilter(e.currentTarget.value)}>
          <option value="">{t('knowledge.search.allDocuments')}</option>
          {(documents.data??[]).map(doc=><option key={doc.scopeId+doc.id} value={doc.id}>{doc.filename}</option>)}
        </select>
        <select aria-label={t('aria.resultCount')} value={resultLimit} onChange={e=>setResultLimit(Number(e.currentTarget.value))}>
          <option value={5}>{t('knowledge.search.limit', { count: 5 })}</option><option value={10}>{t('knowledge.search.limit', { count: 10 })}</option><option value={20}>{t('knowledge.search.limit', { count: 20 })}</option><option value={50}>{t('knowledge.search.limit', { count: 50 })}</option>
        </select>
        <label className={styles.searchTuning}>{t('knowledge.search.threshold', { percent: Math.round(threshold*100) })} <input aria-label={t('aria.threshold')} type="range" min="0" max="0.9" step="0.05" value={threshold} onChange={e=>setThreshold(Number(e.currentTarget.value))}/></label>
        <Button
          variant="outline"
          disabled={!query.trim() || busy}
          onClick={() => setSubmitted(query.trim())}
        >
          {t('knowledge.action.search')}
        </Button>
        {submitted && (
          <Button
            variant="ghost"
            onClick={() => {
              setSubmitted('')
              setQuery('')
            }}
          >
            {t('knowledge.action.clearResults')}
          </Button>
        )}
      </div>
      <div className={styles.knowledgeStatus}>
        <div><strong>{documents.data?.length ?? 0}</strong><span>{t('knowledge.stat.documents')}</span></div>
        <div><strong>{documents.data?.reduce((total, item) => total + item.chunks, 0) ?? 0}</strong><span>{t('knowledge.stat.chunks')}</span></div>
        <div><strong>{submitted ? (hits.data?.length ?? 0) : '—'}</strong><span>{t('knowledge.stat.hits')}</span></div>
      </div>
      {submitted ? (
        <section className={styles.list} aria-label={t('aria.searchResults')}>
          {hits.phase === 'loading' ? (
            <div className={styles.loading}>{t('knowledge.search.loading')}</div>
          ) : hits.error ? (
            <div className={styles.error} role="alert">
              {hits.error}
              <Button onClick={hits.reload}>{t('common.retry')}</Button>
            </div>
          ) : !hits.data?.length ? (
            <div className={styles.empty}>{t('knowledge.search.empty')}</div>
          ) : (
            hits.data.map(hit => (
              <article className={styles.item} key={hit.id}>
                <div className={styles.between}>
                  <div className={styles.itemTitle}>{hit.documentName}</div>
                  <Tag tone="info">{t('knowledge.hit.score', { percent: Math.round(hit.score * 100) })}</Tag>
                </div>
                <p className={styles.source}>{hit.content}</p>
                <div className={styles.meta}>
                  {t('knowledge.hit.chunk', { index: hit.chunkIndex + 1, documentId: hit.documentId })}
                </div>
                <div className={styles.actions}>
                  <Tag tone="outline">{Array.isArray(hit.metadata?.searchModes)?(hit.metadata.searchModes as string[]).join(' + '):searchMode}</Tag>
                  <Button size="sm" variant="ghost" onClick={()=>setDetail({ hit })}>{t('knowledge.action.viewEvidence')}</Button>
                </div>
              </article>
            ))
          )}
        </section>
      ) : (
        <section className={styles.list} aria-label={t('aria.documentList')}>
          {!!documents.data?.length&&<div className={styles.item}>
            <div className={styles.between}><label className={styles.inline}><input type="checkbox" aria-label={t('aria.selectAllDocuments')} checked={selectedIds.size===documents.data.length} onChange={(e)=>{const checked=e.currentTarget.checked;setSelectedIds(checked?new Set(documents.data!.map(doc=>doc.id)):new Set())}}/>{t('knowledge.selectAll')}</label><Button size="sm" variant="outline" disabled={!selectedIds.size||busy} onClick={()=>setPendingBatchDelete(true)}>{t('knowledge.action.deleteSelected', { count: selectedIds.size })}</Button></div>
          </div>}
          {documents.phase === 'loading' ? (
            <div className={styles.loading}>{t('knowledge.documents.loading')}</div>
          ) : documents.error ? (
            <div className={styles.error} role="alert">
              {documents.error}
            </div>
          ) : !documents.data?.length ? (
            <div className={styles.empty}>{t('knowledge.documents.empty')}</div>
          ) : (
            documents.data.map(doc => (
              <article className={styles.item} key={doc.id}>
                <div className={styles.between}>
                  <div className={styles.inline}>
                    <input type="checkbox" aria-label={t('aria.selectDocument', { name: doc.filename })} checked={selectedIds.has(doc.id)} onChange={(e)=>{const checked=e.currentTarget.checked;setSelectedIds((current)=>{const next=new Set(current);if(checked)next.add(doc.id);else next.delete(doc.id);return next})}}/>
                    <div>
                      <div className={styles.itemTitle}>{doc.filename}</div>
                      <div className={styles.badges}>
                        <Tag tone="neutral">{doc.mimeType}</Tag>
                        <Tag tone="outline">{t('knowledge.doc.chunks', { count: doc.chunks })}</Tag>
                        <Tag tone={doc.semanticPending ? 'warning' : doc.semanticIndexed ? 'success' : 'neutral'}>{doc.semanticPending ? t('knowledge.semantic.pending') : doc.semanticIndexed ? t('knowledge.semantic.ready') : t('knowledge.semantic.unknown')}</Tag>
                        <span className={styles.meta}>
                          {formatTime(doc.uploadedAt)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className={styles.actions}>
                    <Button size="sm" variant="ghost" disabled={busy||detailBusy} onClick={()=>void openDocument(doc)}>{t('knowledge.action.viewChunks')}</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={()=>void reindex(doc)}>{t('knowledge.action.reindex')}</Button>
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => setPendingDelete(doc)}>{t('common.delete')}</Button>
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
        title={t('knowledge.delete.title')}
        description={t('knowledge.delete.description')}
        closeLabel={t('common.close')}
        footer={
          <div className={styles.actions}>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setPendingDelete(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => void remove()}
            >
              {busy ? t('knowledge.delete.busy') : t('knowledge.delete.confirm')}
            </Button>
          </div>
        }
      >
        <p className={styles.modalContent}>
          {t('knowledge.delete.question', { name: pendingDelete?.filename })}
        </p>
      </ContextModal>
      <ContextModal
        size="compact"
        open={pendingBatchDelete}
        onClose={()=>!busy&&setPendingBatchDelete(false)}
        title={t('knowledge.batchDelete.title')}
        description={t('knowledge.batchDelete.description')}
        closeLabel={t('common.close')}
        footer={<div className={styles.actions}><Button variant="ghost" disabled={busy} onClick={()=>setPendingBatchDelete(false)}>{t('common.cancel')}</Button><Button variant="primary" disabled={busy} onClick={()=>void removeSelected()}>{busy?t('knowledge.delete.busy'):t('knowledge.batchDelete.confirm',{count:selectedIds.size})}</Button></div>}
      ><p className={styles.modalContent}>{t('knowledge.batchDelete.warning')}</p></ContextModal>
      <ContextModal
        open={detail!==null}
        onClose={()=>setDetail(null)}
        title={detail&&'hit' in detail?t('knowledge.detail.evidenceTitle',{name:detail.hit.documentName}):detail&&'document' in detail?detail.document.filename:t('knowledge.detail.documentTitle')}
        description={detail&&'hit' in detail?t('knowledge.detail.hitMeta',{index:detail.hit.chunkIndex+1,percent:Math.round(detail.hit.score*100)}):detail&&'document' in detail?t('knowledge.detail.documentMeta',{chunks:detail.document.chunks,scope:detail.document.scopeId}):undefined}
        closeLabel={t('common.close')}
        footer={<Button variant="primary" onClick={()=>setDetail(null)}>{t('common.done')}</Button>}
      >
        <div className={styles.modalContent}>
          {detail&&'hit' in detail?<><p className={styles.source}>{detail.hit.content}</p><pre className={styles.source}>{JSON.stringify(detail.hit.metadata,null,2)}</pre></>:detail&&'document' in detail?<div className={styles.stack}>{detail.chunks.map(chunk=><article key={chunk.id} className={styles.panel}><div className={styles.between}><strong>{t('knowledge.detail.chunkTitle',{index:chunk.chunkIndex+1})}</strong><span className={styles.meta}>{chunk.id}</span></div><p className={styles.source}>{chunk.content}</p></article>)}</div>:null}
        </div>
      </ContextModal>
    </div>
  )
}
