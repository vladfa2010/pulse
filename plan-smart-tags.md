# Smart Tag Matching + Related Tags — Plan

## Stage 1: Enhanced Keyword Matching
- Match against title_ru + summary_ru + full text
- More comprehensive keywords per tag
- Synonyms and related terms

## Stage 2: LLM Smart Matching
- Layer 1: Keyword matching (fast, covers 60-70%)
- Layer 2: LLM API for articles with no keyword match
- LLM analyzes title+summary → returns relevant tag IDs
- Saves results to cache to avoid repeated LLM calls

## Stage 3: Related Tags System
- When user adds a tag → suggest related tags
- Related clusters: nvidia → [tech, ai], crypto → [tech, fed], etc.
- Store related_tags in DB or compute dynamically

## Implementation Order
1. rssSources.ts — expand keywords + add full-text matching
2. cron.ts — integrate LLM fallback matching
3. New service: smartTagMatcher.ts
4. New endpoint: GET /api/tags/related?tag=nvidia
5. Frontend integration for related tag suggestions
