import json
from pathlib import Path

root = Path('.')
graph_path = root / 'graphify-out' / 'graph.json'
chunks = sorted(root.glob('graphify-out/.chunk_*.json'))

graph = json.loads(graph_path.read_text(encoding='utf-8'))
existing_nodes = {n['id']: n for n in graph['nodes']}
existing_edges = list(graph['links'])

new_nodes = []
new_edges = []

for chunk_path in chunks:
    chunk = json.loads(chunk_path.read_text(encoding='utf-8'))
    for n in chunk.get('nodes', []):
        if n['id'] not in existing_nodes:
            existing_nodes[n['id']] = n
            new_nodes.append(n)
    for e in chunk.get('edges', []):
        if e['source'] in existing_nodes and e['target'] in existing_nodes:
            new_edges.append(e)

graph['nodes'].extend(new_nodes)
graph['links'].extend(new_edges)

graph_path.write_text(json.dumps(graph, indent=2, ensure_ascii=False), encoding='utf-8')

print(f'Merged {len(chunks)} chunks')
print(f'Added {len(new_nodes)} nodes, {len(new_edges)} edges')
print(f'Total: {len(graph["nodes"])} nodes, {len(graph["links"])} edges')

# Also write a summary file
summary = {
    'chunks': len(chunks),
    'added_nodes': len(new_nodes),
    'added_edges': len(new_edges),
    'total_nodes': len(graph['nodes']),
    'total_edges': len(graph['links']),
}
(root / 'graphify-out' / '.semantic_merge_summary.json').write_text(json.dumps(summary, indent=2), encoding='utf-8')
