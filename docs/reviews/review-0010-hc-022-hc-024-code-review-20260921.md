---
id: REVIEW-0010
name: Code review of HC-022 and HC-024
status: Complete
owners:
    - alistairbayley
created: 2026-09-21
updated: 2026-09-21
reviews: beaa8a3...HEAD
---

# Code review of HC-022 and HC-024

| Stage    | Timestamp  |
| -------- | ---------- |
| Authored | 2026-09-21 |

## Review Scope

Commits `fccb47d` (Generator: framework runnable apps, member-package yield,
inferred-edge precision) and `139ca83` (Docs: resolve HC-022 and HC-024),
diffed against the fixed point `beaa8a3` — where REVIEW-0009's remediation
ended — via `git diff beaa8a3...HEAD` (19 files, 428 insertions). Reviewed on
the two axes the `code-review` skill covers, run as parallel sub-agents:

- **Standards** — conformance to `~/.agents/coding-standards.md`,
  `coding-standards-typescript.md`, `agent-design-and-test-guidance.md`,
  `markdown-rules.md`, and the repo's `AGENTS.md`, plus the Fowler smell
  baseline.
- **Spec** — fidelity to the HC-022 and HC-024 Direction sections as of the
  fixed point (`git show beaa8a3:docs/heuristic-changes.md`).

## Standards

No debris: no `console.log`, `TODO`, or debug leftovers anywhere in the diff
(REVIEW-0009's failure not repeated). Commit messages cite HC IDs; goldens
regenerated intentionally as AGENTS.md requires; rules each have one home per
HEURISTICS.md; British spelling holds throughout.

1. **Hard — module-level mutable cache.** `inventory.ts`'s
   `const yieldChecked = new Map<string, boolean>()` is mutable module state
   persisting across repos in one process (`agent-design-and-test-guidance.md`:
   "Do not use global or module-level mutable application state"). Pass
   root-scoped state explicitly or drop the memo.
2. **Judgement — duplicated yield logic.** `walk` computes the yield predicate
   (`YIELDABLE_DIRS.has(entry.name) && existsSync(.../package.json)`) while
   `excludedByIgnoredDir` reimplements it memoised — two homes for one rule
   that can drift. Extract one `dirYields(dir)` helper.
3. **Minor — table alignment.** HC-022/HC-024 rows in `docs/heuristic-changes.md`
   re-padded by hand (markdown-rules.md MD060); run `md-table-format`.
4. **Judgement — Data Clumps.** `dbWritePattern`/`dbReadPattern`/
   `dbClientPattern` travel as a trio through the context, options, and pass;
   a `DbFlowPatterns` bundle would shrink the plumbing (follows the existing
   clump; noted, not demanded).
5. **Judgement — Duplicated Code in compose.ts.** The `volumesIndent`
   bookkeeping mirrors `dependsOnIndent`'s record/consume/clear shape; a
   shared "block children" helper earns its keep only if a third appears.
6. **Judgement — optional-param re-test.** The M10 guard re-tests
   `options.scriptFiles !== undefined` inside the `every`; hoist to a local.

## Spec

(a) Missing or partial:

1. **M8 guard is deployment-only.** *"M8 could require a server-side
   receiving module..."* — `clientPattern` is passed only in the deployment
   caller; the overview's `inferModuleDataFlows` gets none, so the
   studio-component false positives still fire there.
2. **M10 script guard is deployment-only.** *"M10 could exclude script/QA
   dirs it inherits from R1's sets"* — same asymmetry: the overview's
   `inferExternalDelivers` call passes no script set.
3. **I3 yield ignores the entry requirement.** *"should yield when the
   directory has its own `package.json` **with an entry**"* — the yield
   checks only the manifest's existence; a prose `docs/` dir with a
   manifest but no entry yields and is inventoried.
4. **Framework entry is not the framework's convention.** *"recognise the
   framework's entry conventions"* — the entry is the first inventoried file
   under `app/`/`pages/` (alphabetical: a layout, a CSS file, or a config
   beats a `page.tsx`/`route.ts`).
5. **D3 dev-server arm dropped; tag lands on the service, not the host.** *"tag
   a compose host `dev-environment` on bind-mounting the repo root **or
   running known dev servers**"* — only the bind-mount signal exists, and
   the tag is on the service node.

(b) Scope creep:

1. **D17 dedup suppresses on ANY edge** over the pair, not only D17's `uses`
   — an explicitly declared edge would also suppress the inference.
   Defensible (one relationship, one edge), but beyond the "D17+M10" phrasing.
2. D7's second alternative ("not referenced by any deploy mechanism") was not
   attempted — correctly, since the Direction offered an "or".

(c) Implemented but looks wrong:

1. **DB_CLIENT_PATTERN false negatives.** The pattern omits Prisma
   (`@prisma/client`), Sequelize, and Mongoose — a real server module on
   those stacks with SQL-form matches now draws no edge, trading the
   precision bug for a recall bug on mainstream stacks.
2. **YIELDABLE_DIRS narrowing.** The yield applies only to
   `docs|examples|data`; a workspace member under any other ignored name
   still vanishes — the spec's "package first" principle is not generalised.

## Summary

Standards: 6 findings (1 hard — the module-level mutable cache); worst: the
cross-repo memo in `inventory.ts`. Spec: 9 findings (5 partial, 2 creep,
2 wrong); worst: the deployment-only asymmetry of the M8/M10 guards — the
overview still draws the false positives HC-024 was written to kill.
