# Repository guidance

## Fork workflow

- `origin` is the personal fork at `https://github.com/RowgerGo/claudecodeui`. Develop and commit personal changes on `custom` and push them to `origin/custom` with `git push origin custom`.
- `upstream` is the official repository at `https://github.com/siteboon/claudecodeui`. Use it to fetch updates. **Never push to `siteboon/claudecodeui`, whether through `upstream`, another remote name, or a direct URL.** Before pushing, verify that `git remote get-url --push origin` points to `RowgerGo/claudecodeui`.
- Keep `main` in sync with the official `upstream/main`. Fetch `upstream`, fast-forward local `main` with `git merge --ff-only upstream/main`, then merge `main` into `custom`. To update the fork's remote `main`, use GitHub's **Sync fork** feature.

## Backend code

For every task that creates, modifies, refactors, or reviews backend code under `server/`, load and follow `$backend-module-standards` from `.agents/skills/backend-module-standards/SKILL.md`. Apply it only to backend code; do not impose those architecture rules on the frontend.

## Frontend code

For every task that creates, modifies, refactors, or reviews frontend code under `src/`, load and follow `$frontend-module-standards` from `.agents/skills/frontend-module-standards/SKILL.md`. Apply it only to frontend code; do not impose those architecture rules on the backend.
