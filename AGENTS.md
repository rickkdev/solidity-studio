# Ralph Agent Instructions

## Overview

Ralph is an autonomous AI agent loop that runs AI coding tools repeatedly until all PRD items are complete. Each iteration is a fresh instance with clean context.

## Commands

```bash
ralph run --tool claude
ralph run --tool codex
```

## Key Files

- `prd.json` - PRD with user stories and acceptance criteria.
- `CLAUDE.md` - Ralph workflow prompt for Claude Code.
- `CODEX.md` - Ralph workflow prompt for Codex.
- `progress.txt` - Progress log and reusable learnings.

## Patterns

- Each iteration spawns a fresh AI instance with clean context.
- Memory persists via git history, `progress.txt`, and `prd.json`.
- Stories should be small enough to complete in one context window.
