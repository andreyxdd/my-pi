---
name: impeccable-pi-adapter
description: Pi-specific adapter for the Impeccable frontend design skill. Provides Pi-native workflows for screenshot-based visual iteration and live mode. Use alongside /impeccable commands when working in Pi coding agent.
---

# Impeccable Pi Adapter

Adapts Impeccable's Codex-specific image generation flows to Pi's native capabilities.

## Image Generation → Screenshot-Based Visual Reference

Impeccable's `/impeccable shape` and `/impeccable craft` reference a Codex image generation pipeline (mock generation, palette-first approach, etc.). In Pi, replace that pipeline with browser screenshots:

### Shape workflow (no Codex image gen)

1. **Brand toolkit gathering** — same as Impeccable. Interview user about purpose, audience, goals. Derive color strategy, typography direction, layout principles.
2. **Visual reference via screenshots** instead of mock generation:
   - If the user has an existing page: use `fetch_content` with `frames` to capture current state.
   - If designing from scratch: skip visual mocks. Write a precise design brief instead.
3. **Design brief** — produce the same structured brief Impeccable shape would output. No mocks needed.

### Craft workflow (build from screenshots)

When `/impeccable craft` runs after shape:

1. **Screenshot as visual contract**: capture the current state of the target page:
   ```
   fetch_content(url: "http://localhost:3000/path", frames: 6)
   ```
2. **Ingredient mapping**: map major visible ingredients from the screenshot (or from the design brief if no screenshot) to planned code changes.
3. **Build**: implement the design. No mock approval gate needed — the design brief IS the contract.
4. **Post-build verification**: capture screenshot of the built page and compare to the brief's requirements.

### Palette derivation without image gen

When `/impeccable shape` needs a palette but has no image gen:

- Derive palette from PRODUCT.md brand personality words + cultural context.
- Output OKLCH color tokens directly. No visual plate needed.
- If the user wants visual validation: capture a screenshot of a simple color swatch HTML page rendered in browser.

## Live Mode

Use Impeccable's existing live-server approach (`scripts/live.mjs`). Pi does not have a native browser overlay TUI component, so the flow is:

1. Agent runs `node scripts/live.mjs` (from skill directory)
2. User interacts in browser (pick element, comment, hit Go)
3. Agent polls via `live-poll.mjs`
4. Agent generates variants, injects via `live-inject.mjs`
5. User accepts → agent writes to source via `live-accept.mjs`

The scripts are at: `~/.pi/agent/skills/impeccable/scripts/`

## Detector CLI

Standalone anti-pattern detection without LLM:

```bash
# Fast regex-only scan
node ~/.pi/agent/skills/impeccable/scripts/detector/cli/main.mjs --fast src/

# Full static HTML analysis
node ~/.pi/agent/skills/impeccable/scripts/detector/cli/main.mjs index.html

# URL scanning (requires: npm i puppeteer)
node ~/.pi/agent/skills/impeccable/scripts/detector/cli/main.mjs http://localhost:3000
```

Note: Puppeteer is optional for file scans. Only needed for live URL scanning.

## Pi-Specific Workflow Tips

### Screenshot-driven critique

Use `fetch_content` with `frames` to capture a running page, then run `/impeccable critique` on the screenshots:

```
fetch_content(url: "http://localhost:3000", frames: 8, prompt: "Critique this UI's visual hierarchy, typography, color usage, and layout against the Impeccable anti-pattern rules.")
```

### Knowledge base for design context

Pi's knowledge base can complement PRODUCT.md and DESIGN.md:

- Store brand guidelines, mood boards, design decisions in `evergreen/` notes
- Use `knowledge_search` to retrieve design context across sessions
- PRODUCT.md and DESIGN.md at project root remain the primary source (Impeccable reads those)

### Multi-turn design iteration

Pi's session tree (`/tree`) is useful for design exploration:

1. Start a design session with `/impeccable shape`
2. Fork at decision points to explore variants
3. Navigate back to pick the best direction
