import test from 'node:test';
import assert from 'node:assert/strict';
import { createContextStore } from '../src/context/store.js';
import { createContextService } from '../src/context/service.js';

test('model ontology stays pending and cannot use invented evidence', async t => {
  const store = createContextStore({ dbPath: ':memory:' });
  t.after(() => store.close());
  const service = createContextService({ store, legacy: { list: async () => [], get: async () => [], search: async () => [] }, config: { ontologyEnabled: true }, defaultScope: () => 'ontology' });
  const memory = service.saveMemory({ scopeId: 'ontology', content: 'Alpha depends on Beta.', kind: 'fact' }, { actorRole: 'assistant', kind: 'derived-capture', sourceActorRole: 'human', sourceContent: 'Alpha depends on Beta.', complete: true });
  const result = await service.captureOntologyCandidates({
    scopeId: 'ontology', sourceMemoryId: memory.id,
    entities: [{ name: 'Alpha', type: 'Service', aliases: [] }, { name: 'Beta', type: 'API', aliases: [] }],
    relations: [
      { subject: 'Alpha', predicate: 'depends_on', object: 'Beta', quote: 'Alpha depends on Beta.' },
      { subject: 'Alpha', predicate: 'depends_on', object: 'Beta', quote: 'not in the source' },
    ],
  });
  assert.equal(result.entities.length, 2);
  assert.equal(result.relations.length, 1);
  assert.equal(result.relations[0].status, 'pending');
  const graph = await service.graph({ scopeId: 'ontology', includePending: false });
  assert.ok(!graph.edges.some(edge => edge.relationId === result.relations[0].id));
  assert.equal((await service.listReviews({ scopeId: 'ontology' })).length, 1);
});
