/** This is a desktop domain vocabulary, not an OWL engine or an ACL model. */
export const ENTITY_TYPES = Object.freeze(['Project', 'Person', 'Requirement', 'API', 'Service', 'Constraint', 'Decision', 'Document']);
export const MEMORY_KINDS = Object.freeze(['fact', 'decision', 'preference', 'constraint', 'outcome', 'plan', 'note']);
/**
 * Storage horizon is deliberately independent from memory kind.  A decision
 * can be an episodic account of a single task or a durable semantic fact;
 * conflating those dimensions was the main obstacle to safe promotion and
 * expiry policies.
 *
 * `working` is resumable, bounded task state; `episodic` is a session/task
 * record; `semantic` is durable facts/preferences/decisions; `procedural`
 * is reusable guidance, playbooks and organization-approved ways of working.
 */
export const MEMORY_LAYERS = Object.freeze(['working', 'episodic', 'semantic', 'procedural']);
export const DEFAULT_MEMORY_LAYER = 'semantic';
export const LIFECYCLES = Object.freeze(['active', 'candidate', 'retired']);
export const EPISTEMIC_STATES = Object.freeze(['unverified', 'supported', 'contested', 'refuted']);
export const ACTOR_ROLES = Object.freeze(['human', 'assistant', 'agent', 'tool', 'unknown']);
export const RELATION_STATUSES = Object.freeze(['pending', 'confirmed', 'rejected']);
const definitions = [
  ['belongs_to', 'Belongs to', ['Requirement', 'API', 'Service', 'Constraint', 'Decision', 'Document'], ['Project']],
  ['has_constraint', 'Has constraint', ['Requirement', 'API', 'Service'], ['Constraint']],
  ['implements', 'Implements', ['API', 'Service'], ['Requirement']],
  ['assigned_to', 'Assigned to', ['Requirement', 'Project'], ['Person']],
  ['depends_on', 'Depends on', ['Requirement', 'API', 'Service'], ['Requirement', 'API', 'Service']],
  ['decided_by', 'Decided by', ['Requirement', 'API', 'Service'], ['Decision']],
  ['related_to', 'Related to', [...ENTITY_TYPES], [...ENTITY_TYPES]],
];
const RELATIONS = Object.freeze(definitions.map(([id, label, domain, range]) => Object.freeze({
  id, label, domain: Object.freeze(domain), range: Object.freeze(range),
})));
export const PREDICATES = Object.freeze(RELATIONS.map(x => x.id));
export function relationDefinition(id) { return RELATIONS.find(x => x.id === id); }
export function getSchema() {
  return {
    version: 2,
    memoryLayers: MEMORY_LAYERS.map(id => ({ id, label: id })),
    types: ENTITY_TYPES.map(id => ({ id, label: id })),
    relations: RELATIONS.map(r => ({ ...r, domain: [...r.domain], range: [...r.range] })),
  };
}
