import { extractSemantic } from './extract.js';

const snapshot = {
  snapshotId: 'snap_1',
  nodes: [
    { id: 'price', ref: 'e1', name: '$199', value: null, identityConfidence: 0.95, provenance: { nodeId: 'price' } },
    { id: 'airline', ref: 'e2', name: 'Delta', value: null, identityConfidence: 0.9, provenance: { nodeId: 'airline' } },
  ],
};

test('semantic extraction returns typed data, confidence, and evidence', () => {
  const result = extractSemantic({
    snapshot,
    schema: {
      type: 'object',
      required: ['price', 'airline'],
      properties: {
        price: { type: 'number', 'x-node-id': 'price' },
        airline: { type: 'string', 'x-node-id': 'airline' },
      },
    },
  });
  expect(result.data).toEqual({ price: 199, airline: 'Delta' });
  expect(result.confidence).toBe(0.9);
  expect(result.evidence.price[0].nodeId).toBe('price');
  expect(result.unresolvedFields).toEqual([]);
});
