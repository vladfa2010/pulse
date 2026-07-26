import json
from pathlib import Path
from datetime import datetime, timezone

root = Path('.')
detect = json.loads((root / 'graphify-out' / '.graphify_detect.json').read_text(encoding='utf-8'))

# Update manifest
from graphify.detect import save_manifest
from graphify.cli import _stamped_manifest_files

extract = {'nodes': [], 'edges': [], 'hyperedges': []}
corpus = detect.get('all_files') or detect['files']
scan = {f for fl in corpus.values() for f in fl}
_manifest_files = _stamped_manifest_files(corpus, extract, root)
save_manifest(_manifest_files, root=root, scan_corpus=scan, clear_semantic=None)
print('Manifest updated')

# Update cost tracker with estimated subagent tokens
total_in = 0
total_out = 0
for chunk_path in sorted(root.glob('graphify-out/.chunk_*.json')):
    chunk = json.loads(chunk_path.read_text(encoding='utf-8'))
    total_in += chunk.get('input_tokens', 0)
    total_out += chunk.get('output_tokens', 0)

cost_path = root / 'graphify-out' / 'cost.json'
if cost_path.exists():
    cost = json.loads(cost_path.read_text(encoding='utf-8'))
else:
    cost = {'runs': [], 'total_input_tokens': 0, 'total_output_tokens': 0}

cost['runs'].append({
    'date': datetime.now(timezone.utc).isoformat(),
    'input_tokens': total_in,
    'output_tokens': total_out,
    'files': detect.get('total_files', 0),
})
cost['total_input_tokens'] += total_in
cost['total_output_tokens'] += total_out
cost_path.write_text(json.dumps(cost, indent=2, ensure_ascii=False), encoding='utf-8')

print(f'Tokens: {total_in:,} in, {total_out:,} out')
print(f'Total runs: {len(cost["runs"])}')
