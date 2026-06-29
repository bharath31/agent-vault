# Recording the demo GIF

Goal: a ~30s GIF showing the agent read a PR, pause for approval, then merge with a
fresh token — and the audit trail filling in. Target file: `site/assets/github-agent-demo.gif`.

## Prep

1. Create a throwaway repo and open a tiny PR (one-line change) so a real merge is safe.
   You can reuse `../github-agent/seed-pr.mjs` to seed a PR, or open one by hand.
2. Set up `.env` from `.env.example` with a GitHub App that has `contents: write` /
   `pull_requests: write` on that repo, a seed refresh token, and an OpenRouter key.
3. Make the approval pause visible for the recording — temporarily bump the
   auto-approve delay in `agent.ts` (`setTimeout(..., 2000)` → e.g. `6000`) so the
   "APPROVAL NEEDED" line is on screen long enough to read.

## Record

Two-pane terminal (or split screen):

- Left: `node --env-file=.env --import tsx agent.ts <owner> <repo> <pr-number>`
- Right: `tail -f audit.log`

Capture the sequence:

1. `get_pr` returns the PR summary (immediate — it's a read).
2. The `🔐 APPROVAL NEEDED — github.merge_pr` line appears and the agent pauses.
3. Approval resolves; `token.issued` appears in `audit.log`.
4. The merge succeeds and prints the PR URL.

## Produce

Record with your screen recorder of choice (or `asciinema` → `agg` for a crisp,
small GIF), trim to ~30s, and save to `site/assets/github-agent-demo.gif`. Then
reference it from the landing page hero (Task 8) and this README.
