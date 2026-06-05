/**
 * Lightweight heap snapshot diff — parses two .heapsnapshot V8 files,
 * groups nodes by (type, constructor_name) and reports the constructors
 * whose retained_size grew the most between the two snapshots.
 *
 * Usage: node diff-heapsnapshots.mjs <before.heapsnapshot> <after.heapsnapshot>
 *
 * V8 heapsnapshot format (see https://v8.dev/blog/heap-snapshots):
 * {
 *   snapshot: {
 *     meta: {
 *       node_fields: ['type','name','id','self_size','edge_count','trace_node_id','detachedness'],
 *       node_types: [ ['hidden','array','string','object','code','closure','regexp','number','native','synthetic','concatenated string','sliced string','symbol','bigint','object shape'], 'string', 'number', 'number', 'number', 'number', 'number' ],
 *       edge_fields: [...], ...
 *     }
 *   },
 *   nodes: number[],  // flat array of nodeCount * node_fields.length numbers
 *   edges: number[],
 *   strings: string[],
 * }
 *
 * For each node, name is an index into strings[] (when name is a string-name)
 * and self_size is in bytes. We use self_size (not retained_size — computing
 * retained_size needs dominator-tree analysis which is too heavy for a
 * one-off script).
 */
import { readFileSync } from 'node:fs';

function loadSnapshot(path) {
  console.error(`loading ${path}…`);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  const meta = json.snapshot.meta;
  const nodeFields = meta.node_fields;
  const typeEnum = meta.node_types[0];
  const fieldCount = nodeFields.length;
  const nodes = json.nodes;
  const strings = json.strings;
  const idxType = nodeFields.indexOf('type');
  const idxName = nodeFields.indexOf('name');
  const idxSelfSize = nodeFields.indexOf('self_size');

  // Group by (type:constructorName) and tally counts + total self_size.
  const groups = new Map(); // key -> { count, bytes }
  const total = nodes.length / fieldCount;
  for (let i = 0; i < total; i++) {
    const base = i * fieldCount;
    const t = typeEnum[nodes[base + idxType]] ?? 'unknown';
    const n = strings[nodes[base + idxName]] ?? '';
    const sz = nodes[base + idxSelfSize] ?? 0;
    const key = `${t}::${n.slice(0, 80)}`;
    const cur = groups.get(key);
    if (cur) {
      cur.count += 1;
      cur.bytes += sz;
    } else {
      groups.set(key, { count: 1, bytes: sz });
    }
  }
  return { groups, nodeCount: total };
}

const before = process.argv[2];
const after = process.argv[3];
if (!before || !after) {
  console.error('usage: node diff-heapsnapshots.mjs <before.heapsnapshot> <after.heapsnapshot>');
  process.exit(1);
}

const a = loadSnapshot(before);
const b = loadSnapshot(after);

console.error(`before: ${a.nodeCount} nodes, after: ${b.nodeCount} nodes (Δ ${b.nodeCount - a.nodeCount})`);

// Diff: for each key in either snapshot, compute byte delta + count delta.
const allKeys = new Set([...a.groups.keys(), ...b.groups.keys()]);
const rows = [];
for (const key of allKeys) {
  const x = a.groups.get(key) ?? { count: 0, bytes: 0 };
  const y = b.groups.get(key) ?? { count: 0, bytes: 0 };
  const dCount = y.count - x.count;
  const dBytes = y.bytes - x.bytes;
  // Only report keys whose self_size grew meaningfully.
  if (dBytes > 100_000 || dCount > 1000) {
    rows.push({ key, dCount, dBytes, beforeBytes: x.bytes, afterBytes: y.bytes });
  }
}
rows.sort((p, q) => q.dBytes - p.dBytes);

// Print top 40
console.log('| dBytes (KB) | dCount | before (KB) | after (KB) | key |');
console.log('|---:|---:|---:|---:|---|');
for (const r of rows.slice(0, 40)) {
  const dKB = Math.round(r.dBytes / 1024);
  const beforeKB = Math.round(r.beforeBytes / 1024);
  const afterKB = Math.round(r.afterBytes / 1024);
  console.log(`| ${dKB.toLocaleString()} | ${r.dCount.toLocaleString()} | ${beforeKB.toLocaleString()} | ${afterKB.toLocaleString()} | ${r.key} |`);
}
