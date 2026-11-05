/** Safe domain errors: never include SQL, filesystem paths, or caller content. */
const MESSAGES = Object.freeze({
  INVALID_INPUT: 'The request contains an invalid or oversized field.',
  NOT_FOUND: 'The requested record is not available in this scope.',
  VERSION_CONFLICT: 'The record changed. Refresh it before retrying.',
  IDEMPOTENCY_CONFLICT: 'This request identifier was already used for a different request.',
  ENTITY_CONFLICT: 'This name or alias is already assigned to an entity of this type.',
  TYPE_MISMATCH: 'These entity types cannot be merged.',
  MERGE_CONFLICT: 'The merge would destroy a relationship or create an invalid identity redirect.',
  INVALID_RELATION: 'The relationship does not match the supported schema.',
  INVALID_EVIDENCE: 'The quote must be an exact nonempty excerpt of the recorded source.',
  EVIDENCE_REQUIRED: 'An existing source and exact quote are required for confirmation.',
  INVALID_REFERENCE: 'The referenced record or snapshot is not eligible for this operation.',
  INVALID_TRANSITION: 'This usage phase transition is not allowed.',
  SECRET_REJECTED: 'Credential-shaped content cannot be stored.',
  LIMIT_EXCEEDED: 'This operation exceeds the bounded store limit.',
  STORE_CLOSED: 'The context store is closed.',
  STORE_UNAVAILABLE: 'The context store could not be opened with a compatible SQLite driver.',
  STORE_FAILURE: 'The context store could not complete the operation.',
});

export class ContextError extends Error {
  constructor(code = 'STORE_FAILURE', field) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'STORE_FAILURE';
    super(MESSAGES[safeCode]);
    this.name = 'ContextError';
    this.code = safeCode;
    if (field) this.field = field;
  }
}
export function fail(code, field) { throw new ContextError(code, field); }
export function safeError(error, fallback = 'STORE_FAILURE') {
  return error instanceof ContextError ? error : new ContextError(fallback);
}
