/**
 * Lib-mode knowledge store.
 *
 * Gives the dsh-opencontext plugin document upload + RAG search without
 * requiring a separate OpenContext HTTP daemon. It lives inside the DSH
 * process and stores:
 *
 *   - document metadata in a SQLite table
 *   - document chunks in a SQLite table
 *   - chunk embeddings in a sqlite-vec `vec0` virtual table
 *
 * Embeddings come from the local ONNX embedder
 * (`LocalTransformersEmbeddingProvider`, re-exported by
 * `@melandlabs/opencontext`). Chunking uses the facade's `chunkText`.
 *
 * If `@melandlabs/ai-rag` is not resolvable at runtime (it is a peer of
 * the facade), the store gracefully reports itself as unavailable and
 * the backend falls back to the same structured errors HTTP mode would
 * return.
 */
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getOpenContextPath } from "@melandlabs/env-config";
import { createRequire } from "node:module";
// Native modules stay lazy: importing this module must never fail because a
// prebuilt binary is missing or ABI-mismatched. Only an actual knowledge
// operation pays for them (HOST-REVIEW H3).
const require = createRequire(import.meta.url);
let betterSqlite3 = null;
let sqliteVecModule = null;
export function loadBetterSqlite3() {
    if (betterSqlite3 === null) {
        try {
            betterSqlite3 = require("better-sqlite3");
        }
        catch (error) {
            throw Object.assign(new Error("knowledge storage native driver is unavailable"), { code: "STORE_UNAVAILABLE", cause: error });
        }
    }
    return betterSqlite3;
}
export function loadSqliteVec() {
    if (sqliteVecModule === null) {
        try {
            sqliteVecModule = require("sqlite-vec");
        }
        catch (error) {
            throw Object.assign(new Error("sqlite-vec extension is unavailable"), { code: "STORE_UNAVAILABLE", cause: error });
        }
    }
    return sqliteVecModule;
}
import { cleanMetadata } from "./context/service.js";
const KNOWLEDGE_DB_NAME = "dsh-knowledge.db";
const DEFAULT_VEC_DIMENSION = 384; // Xenova/all-MiniLM-L6-v2
const KNOWLEDGE_APPLICATION_ID = 0x414f434b;
const KNOWLEDGE_SCHEMA_VERSION = 3;
/**
 * sqlite-vec may resolve its native DLL inside app.asar in packaged Electron.
 * Native extensions cannot be loaded from the archive, so retry the exact
 * corresponding app.asar.unpacked path when that file exists.
 */
export function loadSqliteVecExtension(db, vec = loadSqliteVec()) {
    try {
        vec.load(db);
        return;
    }
    catch (archiveError) {
        let resolvedPath = "";
        try {
            resolvedPath = vec.getLoadablePath?.() ?? "";
        }
        catch {}
        const unpackedPath = resolvedPath.replace(/\.asar(?=[\\/])/i, ".asar.unpacked");
        if (!resolvedPath || unpackedPath === resolvedPath || !existsSync(unpackedPath))
            throw archiveError;
        try {
            db.loadExtension(unpackedPath);
        }
        catch {
            throw archiveError;
        }
    }
}
export class LibKnowledgeStore {
    dbPath;
    db = null;
    provider = null;
    providerPromise = null;
    autoProviderDisabled = false;
    vecDimension = DEFAULT_VEC_DIMENSION;
    queryEmbeddingCache = new Map();
    scopeVectorJobs = new Map();
    closed = false;
    constructor(options) {
        this.dbPath = options?.dbPath ?? getOpenContextPath(KNOWLEDGE_DB_NAME);
        if (options && "provider" in options) {
            this.provider = options.provider ?? null;
            this.autoProviderDisabled = options.provider === null;
        }
    }
    async uploadDocument(input) {
        this.ensureDb();
        const db = this.db;
        if (!db) {
            throw new KnowledgeUnavailableError("knowledge storage is unavailable");
        }
        const metadata = cleanMetadata(input.metadata ?? {});
        const documentId = makeDocumentId(input.content, input.filename, input.scopeId, input.userId);
        const chunks = await chunkDocument(input.content);
        if (chunks.length === 0) {
            return { documentId, chunks: 0 };
        }
        const provider = await this.ensureProvider();
        let embeddings = null, dim = null, semanticErrorCode = null;
        if (provider) {
            try {
                const candidate = await provider.embedDocuments(chunks.map((c) => c.content));
                if (candidate.length !== chunks.length) throw new KnowledgeUnavailableError(`embedding count mismatch: expected ${chunks.length}, got ${candidate.length}`);
                dim = candidate[0]?.length ?? provider.getDimensions() ?? DEFAULT_VEC_DIMENSION;
                if (!Number.isSafeInteger(dim) || dim <= 0 || candidate.some((row) => !Array.isArray(row) || row.length !== dim)) throw new KnowledgeUnavailableError("embedding dimensions are invalid");
                embeddings = candidate;
                this.vecDimension = dim;
                this.ensureVectorTable(dim, input.scopeId, input.userId);
            }
            catch (error) {
                // A knowledge upload must remain useful when the company
                // embedding key is absent or the gateway is temporarily down.
                // Persist text + lexical terms now; a later hybrid search or a
                // manual reindex fills the semantic sidecar automatically.
                semanticErrorCode = embeddingErrorCode(error);
            }
        }
        else {
            semanticErrorCode = "EMBEDDING_UNAVAILABLE";
        }
        const now = Date.now();
        const insertChunk = db.prepare(`INSERT INTO chunks
			 (id, documentId, chunkIndex, content, metadata, lexicalIndexed, lexicalVersion)
			 VALUES (?, ?, ?, ?, ?, 1, ?)`);
        const vecTable = embeddings ? this.vecTableName(dim, input.scopeId, input.userId) : null;
        const insertVec = vecTable ? db.prepare(`INSERT INTO ${vecTable} (embedding, chunk_id) VALUES (?, ?)`) : null;
        const insertTerm = db.prepare("INSERT OR REPLACE INTO knowledge_terms(term, chunkId, frequency) VALUES (?, ?, ?)");
        const replaceAll = db.transaction((items) => {
            for (const table of this.vectorTables()) db.prepare(`DELETE FROM ${table} WHERE chunk_id LIKE ?`).run(`${documentId}_chunk_%`);
            db.prepare("DELETE FROM chunks WHERE documentId = ?").run(documentId);
            db.prepare("DELETE FROM documents WHERE id = ?").run(documentId);
            db.prepare(`INSERT INTO documents (id, scopeId, userId, filename, mimeType, uploadedAt, chunkCount, metadata, semanticIndexed, semanticModel, semanticDimensions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(documentId, input.scopeId, input.userId, input.filename, input.mimeType, now, chunks.length, JSON.stringify(metadata), embeddings ? 1 : 0, embeddings ? providerModel(provider) : null, embeddings ? dim : null);
            for (const { chunk, embedding } of items) {
                const chunkId = `${documentId}_chunk_${chunk.index}`;
                insertChunk.run(chunkId, documentId, chunk.index, chunk.content, JSON.stringify({}), KNOWLEDGE_SCHEMA_VERSION);
                for (const [term, frequency] of lexicalTermCounts(documentLexicalText(input.filename, metadata, chunk.content))) insertTerm.run(term, chunkId, frequency);
                if (insertVec && embedding) insertVec.run(this.floatArrayToBytes(embedding), chunkId);
            }
        });
        replaceAll(chunks.map((chunk, i) => ({ chunk, embedding: embeddings?.[i] })));
        return { documentId, chunks: chunks.length, semanticIndexed: !!embeddings, semanticPending: !embeddings, ...(semanticErrorCode ? { semanticErrorCode } : {}) };
    }
    deleteDocumentVectors(documentId, dim, scopeId, userId) {
        if (!this.db)
            return;
        const vecTable = this.vecTableName(dim, scopeId, userId);
        // Remove vectors by prefix so stale rows left by earlier crashes or
        // partially-failed transactions are also cleaned up.
        const deleteVec = this.db.prepare(`DELETE FROM ${vecTable} WHERE chunk_id LIKE ?`);
        const deleteChunks = this.db.prepare("DELETE FROM chunks WHERE documentId = ?");
        const deleteDoc = this.db.prepare("DELETE FROM documents WHERE id = ?");
        const deleteAll = this.db.transaction(() => {
            deleteVec.run(`${documentId}_chunk_%`);
            deleteChunks.run(documentId);
            deleteDoc.run(documentId);
        });
        deleteAll();
    }
    async searchKnowledge(input) {
        this.ensureDb();
        const limit = Math.max(1, Math.min(100, input.limit ?? 5));
        const threshold = typeof input.threshold === "number" ? Math.max(-1, Math.min(1, input.threshold)) : 0.25;
        const mode = ["hybrid", "semantic", "keyword"].includes(input.searchMode) ? input.searchMode : "hybrid";
        const allowedDocuments = Array.isArray(input.documentIds) && input.documentIds.length ? new Set(input.documentIds) : null;
        const metadataFilter = input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata) ? input.metadata : null;
        const scopeCount = Number(this.db.prepare("SELECT count(*) AS count FROM chunks c JOIN documents d ON d.id=c.documentId WHERE d.scopeId=? AND d.userId=?").get(input.scopeId, input.userId)?.count ?? 0);
        if (scopeCount === 0) return { chunks: [], mode, semanticIndexed: true, semanticPending: false };
        const byId = new Map();
        if (mode !== "semantic") {
            await this.ensureLexicalIndex(input.scopeId, input.userId);
            for (const hit of this.searchLexical({ ...input, limit: Math.max(limit * 5, 50) })) byId.set(hit.id, { row: hit, lexical: hit.score });
        }
        if (mode !== "keyword") {
            const provider = await this.ensureProvider();
            if (provider) {
                try {
                    const queryEmbedding = await this.embedQueryCached(provider, input.query);
                    const dim = queryEmbedding.length || provider.getDimensions() || this.vecDimension;
                    await this.ensureScopeVectors(provider, dim, input.scopeId, input.userId);
                    const queryBytes = this.floatArrayToBytes(queryEmbedding);
                    const vecTable = this.vecTableName(dim, input.scopeId, input.userId);
                    const fetchLimit = allowedDocuments ? scopeCount : Math.min(scopeCount, Math.max(limit * 8, 80));
                    const vecRows = fetchLimit > 0 ? this.db.prepare(`SELECT chunk_id, distance FROM ${vecTable} WHERE embedding MATCH ? ORDER BY distance LIMIT ?`).all(queryBytes, fetchLimit) : [];
                    const rows = this.rowsByChunkIds(vecRows.map((row) => row.chunk_id), input.scopeId, input.userId);
                    const rowById = new Map(rows.map((row) => [row.id, row]));
                    for (const vecRow of vecRows) {
                        const row = rowById.get(vecRow.chunk_id);
                        if (!row) continue;
                        const score = Math.max(-1, 1 - (vecRow.distance * vecRow.distance) / 2);
                        const previous = byId.get(row.id) ?? { row: this.visibleChunk(row), lexical: null };
                        previous.semantic = score;
                        byId.set(row.id, previous);
                    }
                }
                catch {
                    // Hybrid retrieval keeps keyword results when embeddings are unavailable.
                }
            }
        }
        const chunks = [];
        for (const value of byId.values()) {
            const row = value.row;
            if (allowedDocuments && !allowedDocuments.has(row.documentId)) continue;
            const documentMetadata = row.metadata?.document ?? {};
            if (metadataFilter && !Object.entries(metadataFilter).every(([key, expected]) => JSON.stringify(documentMetadata?.[key]) === JSON.stringify(expected))) continue;
            const semantic = typeof value.semantic === "number" ? value.semantic : null;
            const lexical = typeof value.lexical === "number" ? value.lexical : null;
            const score = semantic !== null && lexical !== null ? Math.min(1, semantic * .65 + lexical * .35 + .05) : semantic !== null ? semantic * .92 : (lexical ?? 0) * .85;
            if (score < threshold) continue;
            chunks.push({ ...row, score, metadata: { ...row.metadata, searchModes: [semantic !== null ? "semantic" : null, lexical !== null ? "keyword" : null].filter(Boolean), semanticScore: semantic, keywordScore: lexical } });
        }
        chunks.sort((a, b) => b.score - a.score || a.documentName.localeCompare(b.documentName) || a.chunkIndex - b.chunkIndex);
        const pending = Number(this.db.prepare("SELECT count(*) AS count FROM documents WHERE scopeId=? AND userId=? AND chunkCount>0 AND semanticIndexed=0").get(input.scopeId, input.userId)?.count ?? 0);
        return { chunks: diversifyChunks(chunks, limit), mode, semanticIndexed: pending === 0, semanticPending: pending > 0 };
    }
    async listDocuments(input) {
        this.ensureDb();
        const rows = this.db
            ?.prepare(`SELECT id, filename, mimeType, uploadedAt, chunkCount, metadata, semanticIndexed, semanticModel, semanticDimensions
				 FROM documents
				 WHERE scopeId = ? AND userId = ?
				 ORDER BY uploadedAt DESC
				 LIMIT ?`)
            .all(input.scopeId, input.userId, input.limit);
        return {
            documents: rows.map((r) => ({
                id: r.id,
                filename: r.filename,
                mimeType: r.mimeType,
                uploadedAt: r.uploadedAt,
                chunks: r.chunkCount,
                metadata: parseJson(r.metadata),
                semanticIndexed: r.semanticIndexed === 1,
                semanticPending: r.chunkCount > 0 && r.semanticIndexed !== 1,
                semanticModel: r.semanticModel ?? null,
                semanticDimensions: Number.isSafeInteger(r.semanticDimensions) ? r.semanticDimensions : null,
            })),
        };
    }
    async listKnowledgeScopes() {
        this.ensureDb();
        return this.db.prepare(`SELECT scopeId AS id,count(*) AS count,sum(chunkCount) AS chunks
            FROM documents GROUP BY scopeId ORDER BY count DESC,scopeId`).all().map((row) => ({ id: row.id, count: Number(row.count) || 0, chunks: Number(row.chunks) || 0 }));
    }
    async listDocumentChunks(input) {
        const documentId = validDocumentId(input?.id);
        this.ensureDb();
        const document = this.db.prepare(`SELECT id, filename, mimeType, uploadedAt, chunkCount, metadata, semanticIndexed, semanticModel, semanticDimensions
            FROM documents WHERE id=? AND scopeId=? AND userId=?`).get(documentId, input.scopeId, input.userId);
        if (!document) return { document: null, chunks: [] };
        const chunks = this.db.prepare(`SELECT id, documentId, chunkIndex, content, metadata
            FROM chunks WHERE documentId=? ORDER BY chunkIndex LIMIT ?`).all(documentId, Math.max(1, Math.min(5000, input.limit ?? 5000)));
        return {
            document: { id: document.id, filename: document.filename, mimeType: document.mimeType, uploadedAt: document.uploadedAt, chunks: document.chunkCount, metadata: parseJson(document.metadata) ?? {}, semanticIndexed: document.semanticIndexed === 1, semanticPending: document.chunkCount > 0 && document.semanticIndexed !== 1, semanticModel: document.semanticModel ?? null, semanticDimensions: Number.isSafeInteger(document.semanticDimensions) ? document.semanticDimensions : null },
            chunks: chunks.map((row) => ({ id: row.id, documentId: row.documentId, chunkIndex: row.chunkIndex, content: row.content, metadata: parseJson(row.metadata) ?? {} })),
        };
    }
    async reindexDocument(input) {
        const documentId = validDocumentId(input?.id);
        this.ensureDb();
        const document = this.db.prepare("SELECT id,semanticIndexed FROM documents WHERE id=? AND scopeId=? AND userId=?").get(documentId, input.scopeId, input.userId);
        if (!document) return { reindexed: false, chunks: 0 };
        const chunks = this.db.prepare(`SELECT c.id,c.content,d.filename,d.metadata AS documentMetadata
            FROM chunks c JOIN documents d ON d.id=c.documentId WHERE c.documentId=? ORDER BY c.chunkIndex`).all(documentId);
        this.db.transaction(() => {
            this.db.prepare("DELETE FROM knowledge_terms WHERE chunkId LIKE ?").run(`${documentId}_chunk_%`);
            for (const chunk of chunks) this.indexLexicalChunk(chunk.id, chunk.content, chunk.filename, parseJson(chunk.documentMetadata));
        })();
        const provider = await this.ensureProvider();
        let semanticIndexed = document.semanticIndexed === 1, semanticErrorCode = null;
        if (provider && chunks.length) {
            try {
                const embeddings = await provider.embedDocuments(chunks.map((row) => row.content));
                if (embeddings.length !== chunks.length) throw new KnowledgeUnavailableError("embedding count mismatch");
                const dim = embeddings[0]?.length ?? provider.getDimensions() ?? DEFAULT_VEC_DIMENSION;
                if (!Number.isSafeInteger(dim) || dim <= 0 || embeddings.some((row) => !Array.isArray(row) || row.length !== dim)) throw new KnowledgeUnavailableError("embedding dimensions are invalid");
                this.vecDimension = dim;this.ensureVectorTable(dim, input.scopeId, input.userId);
                const table = this.vecTableName(dim, input.scopeId, input.userId), insert = this.db.prepare(`INSERT INTO ${table}(embedding,chunk_id) VALUES (?,?)`);
                this.db.transaction(() => {
                    for (const name of this.vectorTables()) this.db.prepare(`DELETE FROM ${name} WHERE chunk_id LIKE ?`).run(`${documentId}_chunk_%`);
                    for (let index = 0; index < chunks.length; index++) insert.run(this.floatArrayToBytes(embeddings[index]), chunks[index].id);
                    this.db.prepare("UPDATE documents SET semanticIndexed=1,semanticModel=?,semanticDimensions=? WHERE id=?").run(providerModel(provider), dim, documentId);
                })();
                semanticIndexed = true;
            }
            catch (error) { semanticErrorCode = embeddingErrorCode(error); }
        }
        else if (!provider) semanticErrorCode = "EMBEDDING_UNAVAILABLE";
        return { reindexed: true, chunks: chunks.length, semanticIndexed, semanticPending: chunks.length > 0 && !semanticIndexed, ...(semanticErrorCode ? { semanticErrorCode } : {}) };
    }
    async deleteDocuments(input) {
        const ids = [...new Set(Array.isArray(input?.ids) ? input.ids.map(validDocumentId) : [])];
        if (!ids.length || ids.length > 100) throw new KnowledgeUnavailableError("document ids are invalid");
        let deleted = 0;
        for (const id of ids) if ((await this.deleteDocument({ ...input, id })).deleted) deleted++;
        return { deleted, requested: ids.length };
    }
    async deleteDocument(input) {
        const documentId = validDocumentId(input?.id);
        this.ensureDb();
        const db = this.db;
        if (!db) {
            throw new KnowledgeUnavailableError("knowledge storage is unavailable");
        }
        // Scope and user are part of the deletion predicate. A caller can never
        // remove a document that is merely guessed from another scope.
        const row = db.prepare("SELECT id FROM documents WHERE id = ? AND scopeId = ? AND userId = ?").get(documentId, input.scopeId, input.userId);
        if (!row) {
            return { deleted: false };
        }
        // A document may have been embedded under an older model dimension.
        // Clear every owned vector table, rather than only the current provider's
        // table, so deletion remains available while embedding is disabled.
        const vectorTables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'knowledge_vec_%'").all()
            .map((entry) => entry.name)
            .filter((name) => /^knowledge_vec_\d+(?:_[a-f0-9]{16})?$/.test(name));
        const remove = db.transaction(() => {
            for (const name of vectorTables) {
                db.prepare(`DELETE FROM ${name} WHERE chunk_id LIKE ?`).run(`${documentId}_chunk_%`);
            }
            db.prepare("DELETE FROM chunks WHERE documentId = ?").run(documentId);
            db.prepare("DELETE FROM documents WHERE id = ? AND scopeId = ? AND userId = ?").run(documentId, input.scopeId, input.userId);
        });
        remove();
        return { deleted: true };
    }
    rowsByChunkIds(chunkIds, scopeId, userId) {
        if (!chunkIds.length) return [];
        const placeholders = chunkIds.map(() => "?").join(",");
        return this.db.prepare(`SELECT c.id,c.documentId,c.chunkIndex,c.content,c.metadata,d.filename,d.metadata AS documentMetadata
            FROM chunks c JOIN documents d ON d.id=c.documentId
            WHERE c.id IN (${placeholders}) AND d.scopeId=? AND d.userId=?`).all(...chunkIds, scopeId, userId);
    }
    visibleChunk(row) {
        return { id: row.id, content: row.content, documentId: row.documentId, documentName: row.filename, score: 0, chunkIndex: row.chunkIndex, metadata: { ...(parseJson(row.metadata) ?? {}), document: parseJson(row.documentMetadata) ?? {} } };
    }
    searchLexical(input) {
        const terms = lexicalTerms(input.query).slice(0, 32);
        if (!terms.length) return [];
        const placeholders = terms.map(() => "?").join(",");
        const documentIds = Array.isArray(input.documentIds) ? input.documentIds.filter((id) => typeof id === "string" && id) : [];
        const documentClause = documentIds.length ? ` AND d.id IN (${documentIds.map(() => "?").join(",")})` : "";
        const rows = this.db.prepare(`WITH term_stats AS (
                SELECT kt.term,count(*) AS df
                FROM knowledge_terms kt JOIN chunks c ON c.id=kt.chunkId JOIN documents d ON d.id=c.documentId
                WHERE d.scopeId=? AND d.userId=? AND kt.term IN (${placeholders})${documentClause}
                GROUP BY kt.term
            )
            SELECT c.id,c.documentId,c.chunkIndex,c.content,c.metadata,d.filename,d.metadata AS documentMetadata,
                count(DISTINCT kt.term) AS matched,sum(kt.frequency) AS frequency,
                sum(1.0/ts.df) AS idfWeight,(SELECT sum(1.0/df) FROM term_stats) AS queryWeight
            FROM knowledge_terms kt JOIN term_stats ts ON ts.term=kt.term
                JOIN chunks c ON c.id=kt.chunkId JOIN documents d ON d.id=c.documentId
            WHERE d.scopeId=? AND d.userId=? AND kt.term IN (${placeholders})${documentClause}
            GROUP BY c.id ORDER BY idfWeight DESC,matched DESC,frequency DESC LIMIT ?`).all(
                input.scopeId, input.userId, ...terms, ...documentIds,
                input.scopeId, input.userId, ...terms, ...documentIds,
                Math.max(1, Math.min(500, input.limit ?? 50)),
            );
        const normalized = String(input.query ?? "").normalize("NFKC").toLocaleLowerCase();
        return rows.map((row) => {
            const ratio = Number(row.idfWeight) / Math.max(Number(row.queryWeight), Number.EPSILON), phrase = row.content.normalize("NFKC").toLocaleLowerCase().includes(normalized);
            const documentMetadata = parseJson(row.documentMetadata) ?? {};
            const identityTerms = new Set(lexicalTerms(documentLexicalText(row.filename, documentMetadata, "")));
            const identityMatches = terms.filter(term => identityTerms.has(term)).length;
            const base = .15 + ratio * .45 + Math.min(.02, Number(row.frequency) / 200);
            return { ...this.visibleChunk(row), score: phrase ? .99 : Math.min(.98, base + Math.min(.35, identityMatches * .175)) };
        });
    }
    indexLexicalChunk(chunkId, content, filename = "", documentMetadata = {}) {
        this.db.prepare("DELETE FROM knowledge_terms WHERE chunkId=?").run(chunkId);
        const insert = this.db.prepare("INSERT INTO knowledge_terms(term,chunkId,frequency) VALUES (?,?,?)");
        for (const [term, frequency] of lexicalTermCounts(documentLexicalText(filename, documentMetadata, content))) insert.run(term, chunkId, frequency);
        this.db.prepare("UPDATE chunks SET lexicalIndexed=1,lexicalVersion=? WHERE id=?").run(KNOWLEDGE_SCHEMA_VERSION, chunkId);
    }
    async ensureLexicalIndex(scopeId, userId) {
        while (true) {
            const rows = this.db.prepare(`SELECT c.id,c.content,d.filename,d.metadata AS documentMetadata FROM chunks c JOIN documents d ON d.id=c.documentId
                WHERE d.scopeId=? AND d.userId=? AND (c.lexicalIndexed=0 OR c.lexicalVersion<?) LIMIT 500`).all(scopeId, userId, KNOWLEDGE_SCHEMA_VERSION);
            if (!rows.length) return;
            this.db.transaction(() => { for (const row of rows) this.indexLexicalChunk(row.id, row.content, row.filename, parseJson(row.documentMetadata)); })();
        }
    }
    async ensureScopeVectors(provider, dim, scopeId, userId) {
        const jobKey = `${providerModel(provider)}\0${dim}\0${userId}\0${scopeId}`;
        const running = this.scopeVectorJobs.get(jobKey);
        if (running) return running;
        const job = (async () => {
            const table = this.vecTableName(dim, scopeId, userId);
            const tableExisted = !!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
            this.ensureVectorTable(dim, scopeId, userId);
            const model = providerModel(provider);
            const pendingDocuments = Number(this.db.prepare(`SELECT count(*) AS count FROM documents
                WHERE scopeId=? AND userId=? AND chunkCount>0 AND (semanticIndexed=0 OR semanticModel IS NOT ? OR semanticDimensions IS NOT ?)`).get(scopeId, userId, model, dim)?.count ?? 0);
            if (tableExisted && pendingDocuments === 0) return;
            const existing = new Set(this.db.prepare(`SELECT chunk_id FROM ${table}`).all().map((row) => row.chunk_id));
            const missing = this.db.prepare(`SELECT c.id,c.content FROM chunks c JOIN documents d ON d.id=c.documentId
                WHERE d.scopeId=? AND d.userId=? ORDER BY c.id`).all(scopeId, userId).filter((row) => !existing.has(row.id));
            const insert = this.db.prepare(`INSERT INTO ${table}(embedding,chunk_id) VALUES (?,?)`);
            for (let offset = 0; offset < missing.length; offset += 64) {
                const batch = missing.slice(offset, offset + 64), embeddings = await provider.embedDocuments(batch.map((row) => row.content));
                if (embeddings.length !== batch.length || embeddings.some((row) => !Array.isArray(row) || row.length !== dim)) throw new KnowledgeUnavailableError("embedding count or dimensions mismatch");
                this.db.transaction(() => { for (let index = 0; index < batch.length; index++) insert.run(this.floatArrayToBytes(embeddings[index]), batch[index].id); })();
            }
            this.db.prepare("UPDATE documents SET semanticIndexed=1,semanticModel=?,semanticDimensions=? WHERE scopeId=? AND userId=? AND chunkCount>0").run(model, dim, scopeId, userId);
        })();
        this.scopeVectorJobs.set(jobKey, job);
        try { await job; }
        finally { if (this.scopeVectorJobs.get(jobKey) === job) this.scopeVectorJobs.delete(jobKey); }
    }
    async embedQueryCached(provider, query) {
        const now = Date.now(), key = `${providerModel(provider)}\0${String(query).normalize("NFKC").trim()}`;
        for (const [cacheKey, entry] of this.queryEmbeddingCache) if (now - entry.at > 60000) this.queryEmbeddingCache.delete(cacheKey);
        const hit = this.queryEmbeddingCache.get(key);
        if (hit) return hit.promise;
        const promise = Promise.resolve().then(() => provider.embedQuery(query));
        this.queryEmbeddingCache.set(key, { at: now, promise });
        if (this.queryEmbeddingCache.size > 64) this.queryEmbeddingCache.delete(this.queryEmbeddingCache.keys().next().value);
        try { return await promise; }
        catch (error) { if (this.queryEmbeddingCache.get(key)?.promise === promise) this.queryEmbeddingCache.delete(key); throw error; }
    }
    vectorTables() {
        if (!this.db) return [];
        return this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_vec_%'").all().map((row) => row.name).filter((name) => /^knowledge_vec_\d+(?:_[a-f0-9]{16})?$/.test(name));
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        try {
            this.db?.close();
        }
        catch {
            // ignore
        }
        this.db = null;
    }
    ensureDb() {
        if (this.db)
            return;
        ensureDirSync(dirname(this.dbPath));
        const Database = loadBetterSqlite3();
        const db = new Database(this.dbPath);
        try {
            const appId = Number(db.pragma("application_id", { simple: true }) ?? 0);
            const version = Number(db.pragma("user_version", { simple: true }) ?? 0);
            const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((row) => row.name);
            const foreign = names.some((name) => !["documents", "chunks", "knowledge_terms"].includes(name) && !name.startsWith("knowledge_vec_"));
            if (foreign || (appId !== 0 && appId !== KNOWLEDGE_APPLICATION_ID) || version > KNOWLEDGE_SCHEMA_VERSION) throw new KnowledgeUnavailableError("knowledge database is not owned by agentOS context");
            db.pragma("journal_mode = WAL");
            db.pragma("foreign_keys = ON");
            loadSqliteVecExtension(db);
            db.exec(`
			CREATE TABLE IF NOT EXISTS documents (
				id TEXT PRIMARY KEY,
				scopeId TEXT NOT NULL,
				userId TEXT NOT NULL,
				filename TEXT NOT NULL,
				mimeType TEXT NOT NULL,
				uploadedAt INTEGER NOT NULL,
				chunkCount INTEGER NOT NULL DEFAULT 0,
				metadata TEXT,
				semanticIndexed INTEGER NOT NULL DEFAULT 0,
				semanticModel TEXT,
				semanticDimensions INTEGER
			);
			CREATE INDEX IF NOT EXISTS idx_documents_scope ON documents(scopeId, userId);
			CREATE TABLE IF NOT EXISTS chunks (
				id TEXT PRIMARY KEY,
				documentId TEXT NOT NULL,
				chunkIndex INTEGER NOT NULL,
				content TEXT NOT NULL,
				metadata TEXT,
				lexicalIndexed INTEGER NOT NULL DEFAULT 0,
				lexicalVersion INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY(documentId) REFERENCES documents(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(documentId);
			CREATE TABLE IF NOT EXISTS knowledge_terms (
				term TEXT NOT NULL,
				chunkId TEXT NOT NULL,
				frequency INTEGER NOT NULL,
				PRIMARY KEY(term, chunkId),
				FOREIGN KEY(chunkId) REFERENCES chunks(id) ON DELETE CASCADE
			);
			CREATE INDEX IF NOT EXISTS idx_knowledge_terms_chunk ON knowledge_terms(chunkId);
		`);
            const chunkColumns = new Set(db.prepare("PRAGMA table_info(chunks)").all().map((row) => row.name));
            const documentColumns = new Set(db.prepare("PRAGMA table_info(documents)").all().map((row) => row.name));
            if (!documentColumns.has("semanticIndexed")) db.exec("ALTER TABLE documents ADD COLUMN semanticIndexed INTEGER NOT NULL DEFAULT 0");
            if (!documentColumns.has("semanticModel")) db.exec("ALTER TABLE documents ADD COLUMN semanticModel TEXT");
            if (!documentColumns.has("semanticDimensions")) db.exec("ALTER TABLE documents ADD COLUMN semanticDimensions INTEGER");
            if (!chunkColumns.has("lexicalIndexed")) db.exec("ALTER TABLE chunks ADD COLUMN lexicalIndexed INTEGER NOT NULL DEFAULT 0");
            if (!chunkColumns.has("lexicalVersion")) db.exec("ALTER TABLE chunks ADD COLUMN lexicalVersion INTEGER NOT NULL DEFAULT 0");
            // Create indexes that depend on migrated columns only after the
            // corresponding ALTER TABLE statements have completed. Older
            // knowledge databases do not have lexicalVersion yet.
            db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_lexical_state ON chunks(lexicalIndexed, lexicalVersion, documentId)");
            if (appId === 0) db.pragma("application_id = " + KNOWLEDGE_APPLICATION_ID);
            if (version < KNOWLEDGE_SCHEMA_VERSION) db.pragma("user_version = " + KNOWLEDGE_SCHEMA_VERSION);
            this.db = db;
        }
        catch (error) {
            try { db.close(); } catch {}
            if (error instanceof KnowledgeUnavailableError) throw error;
            const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
            const message = typeof error?.message === "string" ? error.message : String(error);
            console.warn(`[agentos-context] knowledge database initialization failed (${code}): ${message}`);
            throw new KnowledgeUnavailableError("knowledge storage is unavailable");
        }
    }
    ensureVectorTable(dim, scopeId, userId) {
        if (!this.db)
            return;
        const tableName = this.vecTableName(dim, scopeId, userId);
        const exists = this.db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
            .get(tableName);
        if (exists)
            return;
        this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(embedding float[${dim}], chunk_id TEXT PRIMARY KEY)`);
    }
    vecTableName(dim, scopeId, userId) {
        const partition = createHash("sha256").update(`${userId}\0${scopeId}`).digest("hex").slice(0, 16);
        return `knowledge_vec_${dim}_${partition}`;
    }
    async ensureProvider() {
        if (this.provider)
            return this.provider;
        if (this.autoProviderDisabled)
            return null;
        if (this.providerPromise)
            return this.providerPromise;
        this.providerPromise = (async () => {
            try {
                const mod = await import("@melandlabs/opencontext");
                const LocalProvider = mod.LocalTransformersEmbeddingProvider;
                if (typeof LocalProvider === "function") {
                    return new LocalProvider();
                }
            }
            catch {
                // optional peer not available
            }
            return null;
        })();
        this.provider = await this.providerPromise;
        return this.provider;
    }
    floatArrayToBytes(arr) {
        const buffer = Buffer.allocUnsafe(arr.length * 4);
        for (let i = 0; i < arr.length; i++) {
            const value = arr[i];
            buffer.writeFloatLE(value, i * 4);
        }
        return buffer;
    }
}
export class KnowledgeUnavailableError extends Error {
    constructor(message) {
        super(message);
        this.name = "KnowledgeUnavailableError";
    }
}
function validDocumentId(value) {
    const documentId = typeof value === "string" ? value.trim() : "";
    if (!documentId || documentId.length > 512 || /[\0-\x1f]/.test(documentId)) throw new KnowledgeUnavailableError("document id is invalid");
    return documentId;
}
function providerModel(provider) {
    try { return String(provider?.getModelName?.() ?? "unknown"); }
    catch { return "unknown"; }
}
function embeddingErrorCode(error) {
    const code = typeof error?.code === "string" && error.code ? error.code : "EMBEDDING_UNAVAILABLE";
    return code.slice(0, 128);
}
function lexicalTerms(value) {
    const normalized = String(value ?? "").normalize("NFKC").toLocaleLowerCase();
    const terms = [];
    for (const token of normalized.match(/[\p{L}\p{N}]+/gu) ?? []) {
        if (/^[\p{Script=Han}]+$/u.test(token)) {
            if (token.length <= 16) terms.push(token);
            for (let index = 0; index < token.length - 1; index++) terms.push(token.slice(index, index + 2));
        }
        else if (token.length >= 2 && token.length <= 64 && !LEXICAL_STOP_WORDS.has(token)) {
            terms.push(token);
            const fiscalYear = token.match(/^fy(\d{2}|\d{4})$/u)?.[1];
            if (fiscalYear) terms.push(fiscalYear.length === 2 ? `20${fiscalYear}` : fiscalYear);
        }
    }
    return [...new Set(terms)].slice(0, 256);
}
const LEXICAL_STOP_WORDS = new Set([
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does", "for", "from", "give", "had", "has", "have", "how", "if", "in", "into", "is", "it", "its", "of", "on", "only", "or", "state", "that", "the", "then", "this", "to", "use", "using", "was", "were", "what", "when", "where", "which", "who", "why", "with", "would", "year",
]);
function diversifyChunks(chunks, limit) {
    const groups = new Map();
    for (const chunk of chunks) {
        const group = groups.get(chunk.documentId) ?? [];
        group.push(chunk);
        groups.set(chunk.documentId, group);
    }
    const result = [];
    for (let depth = 0; result.length < limit; depth++) {
        let added = false;
        for (const group of groups.values()) {
            if (group[depth]) {
                result.push(group[depth]);
                added = true;
                if (result.length >= limit) break;
            }
        }
        if (!added) break;
    }
    return result;
}
function lexicalTermCounts(value) {
    const counts = new Map();
    for (const term of lexicalTerms(value)) counts.set(term, (counts.get(term) ?? 0) + 1);
    return counts;
}
function documentLexicalText(filename, metadata, content) {
    const labels = [filename];
    if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
        for (const [key, value] of Object.entries(metadata)) {
            if (typeof value === "string" || typeof value === "number") labels.push(key, String(value));
        }
    }
    labels.push(content);
    return labels.join("\n");
}
function makeDocumentId(content, filename, scopeId, userId) {
    const hash = createHash("sha256")
        .update(`${userId}:${scopeId}:${filename}:${content.slice(0, 4096)}`)
        .digest("hex");
    return `doc-${hash.slice(0, 24)}`;
}
async function chunkDocument(content) {
    if (!content.trim())
        return [];
    try {
        const mod = await import("@melandlabs/opencontext");
        const chunkTextFn = mod
            .chunkText;
        if (typeof chunkTextFn === "function") {
            const raw = chunkTextFn(content, { maxChunkSize: 800, chunkOverlap: 100 });
            return raw.map((c, i) => ({ content: c.content, index: c.index ?? i }));
        }
    }
    catch {
        // Fall through to simple splitter if the facade is not resolvable.
    }
    return simpleChunk(content, 800, 100);
}
function simpleChunk(text, size, overlap) {
    const chunks = [];
    let start = 0;
    let index = 0;
    while (start < text.length) {
        const end = Math.min(start + size, text.length);
        chunks.push({ content: text.slice(start, end).trim(), index });
        if (end === text.length)
            break;
        start = end - overlap;
        index++;
    }
    return chunks;
}
function parseJson(raw) {
    if (!raw)
        return undefined;
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
function ensureDirSync(dir) {
    try {
        mkdirSync(dir, { recursive: true });
    }
    catch {
        // ignore
    }
}
//# sourceMappingURL=knowledge-store.js.map
