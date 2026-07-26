#!/usr/bin/env python3
"""Generate a self-contained HTML report from a graphify knowledge graph."""

import json
import html
import os
from collections import defaultdict, Counter

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
WORK_DIR = "/Users/vladislavbaklykov/Desktop/Результат КИМИ/KimiKOD/pulse kode"
GRAPH_PATH = os.path.join(WORK_DIR, "graphify-out", "graph.json")
OUTPUT_PATH = os.path.join(WORK_DIR, "graphify-out", "pulse-kode-callflow.html")

# ---------------------------------------------------------------------------
# Load graph
# ---------------------------------------------------------------------------
with open(GRAPH_PATH, "r", encoding="utf-8") as f:
    graph = json.load(f)

nodes = graph.get("nodes", [])
links = graph.get("links", [])

# Build node lookup
node_by_id = {n["id"]: n for n in nodes}

# Compute degree (undirected)
degree = Counter()
for link in links:
    s, t = link.get("source"), link.get("target")
    if s in node_by_id and t in node_by_id:
        degree[s] += 1
        degree[t] += 1

# Assign degree to each node for convenience
for n in nodes:
    n["degree"] = degree.get(n["id"], 0)

# Group nodes by community
communities = defaultdict(list)
for n in nodes:
    communities[n.get("community")].append(n)

# Sort community IDs naturally (numeric when possible, otherwise string)

def sort_key(item):
    cid, _ = item
    try:
        return (0, int(cid))
    except Exception:
        return (1, str(cid))

sorted_communities = sorted(communities.items(), key=sort_key)

# Precompute edges per community (internal edges, both endpoints in the community)
community_internal_links = defaultdict(list)
for link in links:
    s, t = link.get("source"), link.get("target")
    if s in node_by_id and t in node_by_id:
        s_comm = node_by_id[s].get("community")
        t_comm = node_by_id[t].get("community")
        if s_comm == t_comm:
            community_internal_links[s_comm].append(link)


def sanitize_mermaid_label(text, max_len=60):
    """Make a string safe for Mermaid double-quoted node labels."""
    if not isinstance(text, str):
        text = str(text)
    text = text.replace('\\', '/').replace('"', "'").replace('\n', ' ').replace('\r', '')
    # Brackets can confuse Mermaid's parser even inside quotes; replace them.
    text = text.replace('[', '(').replace(']', ')')
    text = text.replace('{', '(').replace('}', ')')
    if len(text) > max_len:
        text = text[:max_len - 1].rstrip() + "…"
    return text.strip()


def build_mermaid_for_community(cid, nodes_in_comm, internal_links):
    """Build a Mermaid graph definition for the top-20 nodes by degree."""
    top_nodes = sorted(nodes_in_comm, key=lambda x: x.get("degree", 0), reverse=True)[:20]
    top_ids = {n["id"] for n in top_nodes}
    id_map = {n["id"]: f"c{cid}_{idx}" for idx, n in enumerate(top_nodes)}

    lines = ["graph TD"]
    for idx, n in enumerate(top_nodes):
        mid = id_map[n["id"]]
        label = sanitize_mermaid_label(n.get("label", n["id"]))
        lines.append(f'    {mid}["{label}"]')

    # Add edges between top nodes only
    seen_edges = set()
    for link in internal_links:
        s, t = link.get("source"), link.get("target")
        if s in top_ids and t in top_ids:
            # Use sorted tuple for undirected uniqueness
            edge_key = tuple(sorted((s, t)))
            if edge_key in seen_edges:
                continue
            seen_edges.add(edge_key)
            rel = sanitize_mermaid_label(link.get("relation", ""), max_len=30)
            if rel:
                lines.append(f'    {id_map[s]} -->|"{rel}"| {id_map[t]}')
            else:
                lines.append(f'    {id_map[s]} --> {id_map[t]}')

    return "\n".join(lines)


def community_metrics(cid, nodes_in_comm, internal_links):
    n = len(nodes_in_comm)
    e = len(internal_links)
    max_edges = n * (n - 1) / 2 if n > 1 else 0
    cohesion = round(e / max_edges, 4) if max_edges else 0.0
    return n, e, cohesion


# ---------------------------------------------------------------------------
# HTML parts
# ---------------------------------------------------------------------------
HEAD = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pulse Kode — Graphify Callflow Report</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"></script>
<style>
:root {
  --bg: #0f172a;
  --card: #1e293b;
  --accent: #38bdf8;
  --text: #e2e8f0;
  --muted: #94a3b8;
  --border: #334155;
  --hover: #27354f;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2rem 1rem;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
}
.container {
  max-width: 1200px;
  margin: 0 auto;
}
header {
  margin-bottom: 1.5rem;
}
header h1 {
  color: var(--accent);
  margin: 0 0 0.5rem;
  font-size: 1.8rem;
}
header p {
  color: var(--muted);
  margin: 0;
}
.summary-card,
.community-card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
}
.summary-card {
  display: flex;
  flex-wrap: wrap;
  gap: 1.5rem;
}
.metric {
  display: flex;
  flex-direction: column;
}
.metric-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--accent);
}
.metric-label {
  font-size: 0.85rem;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.community-nav {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1rem 1.25rem;
  margin-bottom: 1.5rem;
  max-height: 260px;
  overflow-y: auto;
}
.community-nav h2 {
  margin: 0 0 0.75rem 0;
  font-size: 1.1rem;
  color: var(--accent);
}
.community-nav ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem 0.8rem;
}
.community-nav a {
  color: var(--text);
  text-decoration: none;
  font-size: 0.85rem;
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
}
.community-nav a:hover {
  background: var(--hover);
  color: var(--accent);
}
.community-card summary {
  cursor: pointer;
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--accent);
  list-style: none;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0;
}
.community-card summary::-webkit-details-marker { display: none; }
.community-card summary::before {
  content: "▶";
  color: var(--muted);
  font-size: 0.8rem;
  transition: transform 0.15s;
}
.community-card[open] summary::before {
  content: "▼";
}
.community-card .metrics {
  display: flex;
  gap: 1.5rem;
  flex-wrap: wrap;
  margin: 1rem 0;
  padding: 0.75rem 1rem;
  background: var(--bg);
  border-radius: 8px;
}
.community-card .metrics .metric-value {
  font-size: 1.2rem;
}
.mermaid-wrap {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 1rem;
  margin: 1rem 0;
  overflow-x: auto;
  min-height: 120px;
}
.mermaid-diagram svg {
  display: block;
  margin: 0 auto;
  max-width: 100%;
}
.mermaid-error {
  color: #f87171;
  font-size: 0.9rem;
}
.table-wrap {
  margin: 1rem 0;
  overflow-x: auto;
  max-height: 520px;
  overflow-y: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th, td {
  border: 1px solid var(--border);
  padding: 0.55rem 0.75rem;
  text-align: left;
  vertical-align: top;
}
th {
  background: var(--hover);
  color: var(--accent);
  position: sticky;
  top: 0;
  z-index: 1;
}
tr:nth-child(even) { background: rgba(255,255,255,0.03); }
tr:hover { background: var(--hover); }
.type-pill {
  display: inline-block;
  padding: 0.15rem 0.4rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
}
.type-concept { background: #0369a1; color: #e0f2fe; }
.type-code { background: #047857; color: #d1fae5; }
.type-rationale { background: #7c3aed; color: #ede9fe; }
.type-document { background: #b45309; color: #fef3c7; }
.type-other { background: #475569; color: #f1f5f9; }
footer {
  margin-top: 2rem;
  text-align: center;
  color: var(--muted);
  font-size: 0.85rem;
}
</style>
</head>
<body>
<div class="container">
"""

HEADER_BODY = """
  <header>
    <h1>Pulse Kode — Graphify Knowledge Graph Report</h1>
    <p>Self-contained callflow / knowledge graph visualization.</p>
  </header>
"""

FOOTER = """
  <footer>
    Generated by generate_callflow_html.py from graphify-out/graph.json
  </footer>
</div>
"""

TAIL = """
<script>
(function () {
  mermaid.initialize({
    startOnLoad: false,
    theme: 'dark',
    securityLevel: 'loose',
    flowchart: { useMaxWidth: true, htmlLabels: true, curve: 'basis' }
  });

  function renderDiagram(details) {
    var cid = details.getAttribute('data-cid');
    if (!cid) return;
    var srcEl = document.querySelector('pre.mermaid-src[data-cid="' + cid + '"]');
    var targetEl = document.querySelector('.mermaid-diagram[data-cid="' + cid + '"]');
    if (!srcEl || !targetEl || targetEl.getAttribute('data-rendered') === 'true') return;

    var uid = 'mermaid-c-' + cid;
    mermaid.render(uid, srcEl.textContent).then(function (result) {
      targetEl.innerHTML = result.svg;
      targetEl.setAttribute('data-rendered', 'true');
      // Mermaid injects duplicated styles; keep only the first per diagram.
      var style = targetEl.querySelector('style');
      if (style) {
        style.textContent = style.textContent.replace(/#mermaid-c-\\d+/g, '');
      }
    }).catch(function (err) {
      console.error('Mermaid render failed for community ' + cid, err);
      targetEl.innerHTML = '<p class="mermaid-error">⚠ Mermaid could not render this diagram. ' +
        'Try opening a smaller community or check the browser console.</p>';
    });
  }

  document.querySelectorAll('details.community-card').forEach(function (details) {
    details.addEventListener('toggle', function () {
      if (details.open) renderDiagram(details);
    });
  });

  // Render any already-open sections (e.g., from deep links).
  document.querySelectorAll('details.community-card[open]').forEach(renderDiagram);
})();
</script>
</body>
</html>
"""


def type_pill(file_type):
    cls = file_type.lower() if file_type else "other"
    if cls not in {"concept", "code", "rationale", "document"}:
        cls = "other"
    return f'<span class="type-pill type-{cls}">{html.escape(str(file_type or "other"))}</span>'


def generate_report():
    parts = []
    parts.append(HEAD)
    parts.append(HEADER_BODY)

    # Summary
    total_communities = len(communities)
    parts.append('  <section class="summary-card">\n')
    parts.append(f'    <div class="metric"><span class="metric-value">{len(nodes):,}</span><span class="metric-label">Nodes</span></div>\n')
    parts.append(f'    <div class="metric"><span class="metric-value">{len(links):,}</span><span class="metric-label">Edges</span></div>\n')
    parts.append(f'    <div class="metric"><span class="metric-value">{total_communities:,}</span><span class="metric-label">Communities</span></div>\n')
    parts.append('  </section>\n')

    # Navigation
    parts.append('  <nav class="community-nav" id="community-nav">\n')
    parts.append('    <h2>Jump to community</h2>\n')
    parts.append('    <ul>\n')
    for cid, members in sorted_communities:
        name = members[0].get("community_name", "Unnamed") if members else "Unnamed"
        anchor = f"community-{html.escape(str(cid))}"
        parts.append(f'      <li><a href="#{anchor}">C{cid}: {html.escape(name)}</a></li>\n')
    parts.append('    </ul>\n')
    parts.append('  </nav>\n')

    parts.append('  <div id="community-sections">\n')

    for cid, members in sorted_communities:
        name = members[0].get("community_name", "Unnamed") if members else "Unnamed"
        anchor = f"community-{html.escape(str(cid))}"
        n_count, e_count, cohesion = community_metrics(cid, members, community_internal_links.get(cid, []))
        mermaid_src = build_mermaid_for_community(cid, members, community_internal_links.get(cid, []))

        # Sort all members by degree descending for the table
        table_nodes = sorted(members, key=lambda x: x.get("degree", 0), reverse=True)

        parts.append(f'  <details class="community-card" id="{anchor}" data-cid="{html.escape(str(cid))}">\n')
        parts.append(f'    <summary>Community {html.escape(str(cid))} — {html.escape(name)}</summary>\n')

        parts.append('    <div class="metrics">\n')
        parts.append(f'      <div class="metric"><span class="metric-value">{n_count}</span><span class="metric-label">Nodes</span></div>\n')
        parts.append(f'      <div class="metric"><span class="metric-value">{e_count}</span><span class="metric-label">Internal edges</span></div>\n')
        parts.append(f'      <div class="metric"><span class="metric-value">{cohesion:.4f}</span><span class="metric-label">Cohesion</span></div>\n')
        parts.append('    </div>\n')

        parts.append('    <div class="mermaid-wrap">\n')
        parts.append('      <p style="color:var(--muted);margin:0 0 0.5rem;font-size:0.85rem;">Top 20 nodes by degree and edges inside this community</p>\n')
        parts.append(f'      <pre class="mermaid-src" data-cid="{html.escape(str(cid))}" hidden>{html.escape(mermaid_src)}</pre>\n')
        parts.append(f'      <div class="mermaid-diagram" data-cid="{html.escape(str(cid))}"></div>\n')
        parts.append('    </div>\n')

        parts.append('    <div class="table-wrap">\n')
        parts.append('      <table>\n')
        parts.append('        <thead><tr><th>Label</th><th>Type</th><th>Source file</th><th>Location</th></tr></thead>\n')
        parts.append('        <tbody>\n')
        for node in table_nodes:
            label = html.escape(str(node.get("label", "")))
            file_type = type_pill(node.get("file_type"))
            source_file = html.escape(str(node.get("source_file", "")))
            source_loc = html.escape(str(node.get("source_location", "")))
            parts.append(f'          <tr><td>{label}</td><td>{file_type}</td><td>{source_file}</td><td>{source_loc}</td></tr>\n')
        parts.append('        </tbody>\n')
        parts.append('      </table>\n')
        parts.append('    </div>\n')

        parts.append('  </details>\n')

    parts.append('  </div>\n')
    parts.append(FOOTER)
    parts.append(TAIL)

    return "".join(parts)


# ---------------------------------------------------------------------------
# Write output
# ---------------------------------------------------------------------------
html_report = generate_report()
with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
    f.write(html_report)

print(f"Wrote {OUTPUT_PATH}")
print(f"  HTML size: {os.path.getsize(OUTPUT_PATH):,} bytes")
print(f"  Nodes: {len(nodes):,}")
print(f"  Edges: {len(links):,}")
print(f"  Communities: {len(communities):,}")
first_names = [members[0].get("community_name", "Unnamed") for _, members in sorted_communities[:3]]
print("  First 3 community names:", first_names)
