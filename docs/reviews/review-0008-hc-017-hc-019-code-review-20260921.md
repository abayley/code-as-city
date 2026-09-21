---
id: REVIEW-0008
name: Code review of HC-017 and HC-019
status: Complete
owners:
    - alistairbayley
created: 2026-09-21
updated: 2026-09-21
reviews: working tree vs 6cf0662
---

# Code review of HC-017 and HC-019

| Stage       | Timestamp  |
| ----------- | ---------- |
| Authored    | 2026-09-21 |
| Remediated  | 2026-09-21 |
| Completed   | 2026-09-21 |

## Review Scope

The change set was uncommitted in the working tree; HEAD equalled the fixed
point `6cf0662`, so the review diffed the working tree against that commit
(17 modified files plus the untracked `test/fixtures/mini-repo/packages/ml/`).
There were no commits, so the diff was the whole review scope. Reviewed on
the two axes the `code-review` skill covers, run as parallel sub-agents:

- **Standards** — conformance to `~/.agents/coding-standards.md`,
  `coding-standards-typescript.md`, `markdown-rules.md`, and the repo's
  `AGENTS.md`, plus the Fowler smell baseline.
- **Spec** — fidelity to the HC-017 and HC-019 Direction sections in
  `docs/heuristic-changes.md`.

The two reports below are the sub-agents' findings as they stood before
remediation.

## Standards

1. **Hard — `src/lib/scans.ts` duplicated, contradictory doc comment.** Two
   consecutive JSDoc blocks above `ENDPOINT_ENV_OVERRIDES`; the first ("When
   an SDK importer's source references...") is a stale draft contradicting
   the second on SDK scoping.
2. **Hard — `docs/heuristic-changes.md` table alignment**
   (markdown-rules.md, MD060 + `md-table-format`): the new HC rows are
   inconsistently padded — HC-018/020/022 align while HC-019, HC-021,
   HC-024, HC-025, HC-028 leave ragged columns.
3. **Judgement — Primitive Obsession** (`inference.ts`
   `resolveServiceEndpoint`): `kebab("external-${override.label}")`
   re-derives the id format that lives in `scans.ts`, and
   `override.label === service.label` uses a display label as the identity
   test. One "id/identity from label" helper would remove both.
4. **Judgement — Data Clumps**: `ENDPOINT_ENV_OVERRIDES`' inline anonymous
   `{pattern,label,deps}` type vs the neighbouring tuple style. Minor.
5. **Judgement — Speculative Generality** (`dockerfile.ts`):
   `join(contextDir ?? ".", found)` — the `?? "."` branch is unreachable
   given the predicate above. Trivial.
6. **Judgement — redundant guards** in `isLocalContext`: the `https?:` check
   is near-subsumed by the generic scheme regex.
7. **Judgement** — `parseDockerfile`'s fourth positional optional vs the
   sibling options-object style; borderline.

Suppressed by repo convention: the `**Evidence.**` pseudo-labels (all HC
entries use them); the fixture's `python ... .ts` Dockerfile (minimal immich
mirror). Compliant: rule homes, goldens regenerated and explained, TSDoc,
test seams, British spelling.

## Spec

(a) Missing/partial:

1. **D3 resolution order contradicts the spec sentence.** *"a relative
   `dockerfile` resolves against the context, not the repo root"* — the code
   tries repo root first, then compose dir, then context. Deliberate (the
   monorepo convention), but recorded as an implementation detail in
   HEURISTICS.md, not as a departure from the Direction in the HC-017 entry.
2. **Paperclip verification not evidenced.** *"Verify the paperclip
   deps-stage case separately"* — deferred in the Resolution with no test,
   run, or analysis behind the deferral.
3. **The D12 decision is recorded nowhere durable.** *"Decide whether a URL
   constant in deploy-reachable source is a D12-class signal"* — "stays
   open" lives only in the HC prose; HEURISTICS.md's D12 row is untouched
   (the purpose-split half *is* recorded in D17's failure modes).

(b) Scope creep: the diff also carried the whole comparison-run catalogue —
the rewritten preamble, eleven new Proposed HC entries, and the rewritten
repositories-examined verdicts. Doc-only, but a separate reviewable unit
from the code.

(c) Looks wrong:

1. The env-var match does **not** follow "the M6 window is the model" —
   `override.pattern.test(fileText(file))` scans the whole file with no
   ±4-line window or comment guard; a file mentioning the env var in a
   comment or unrelated context resolves the service.
2. The same duplicated JSDoc as Standards finding 1.

## Remediation

Every finding addressed, by code change, doc change, or recorded decision:

| Finding | Remediation |
| ------- | ----------- |
| S1 stale JSDoc | Deleted the first block; one JSDoc home above `ENDPOINT_ENV_OVERRIDES` |
| S2 table alignment | `md-table-format docs/heuristic-changes.md` |
| S3 primitive obsession | `externalNodeId(label)` in `scans.ts` is the one home for the id format, used by detection and resolution; the identity test compares node ids, not labels |
| S4 data clumps | Named type `EndpointEnvOverride`; the table is `readonly EndpointEnvOverride[]` |
| S5 unreachable `?? "."` | The entry-token loop resolves each token explicitly (repo root, then context) and breaks with the matched path; no fallback expression |
| S6 redundant guards | `isLocalContext` keeps absolute-path and one scheme regex (now case-insensitive); the `https?:` line is gone |
| S7 positional optional | Accepted as-is: one optional parameter with TSDoc; an options object would be ceremony (judgement recorded, not changed) |
| SP-A1 resolution order | Recorded in the HC-017 Resolution as a deliberate departure from the Direction sentence, with the monorepo-convention reasoning |
| SP-A2 paperclip evidence | Verified against a generated `deploy-shape.json`: both services bind; the attributed copies are exactly the deps-stage manifests + entrypoint script; the `COPY --from=build` stage attributes nothing. Recorded in the HC-017 Resolution |
| SP-A3 D12 decision | Now durable: HEURISTICS.md's D12 row carries the open question (ollama-code's clearcut endpoint as the example) |
| SP-B1 scope creep | The catalogue docs (heuristic-changes.md, this review) are committed separately from the generator change |
| SP-C1 window model | Comment-stripped matching implemented (`stripJsComments` in `text.ts`, TDD: a comment-only reference no longer resolves); the M6 window's intent (no match on prose) adopted, its ±4-line literal not, with the reasoning recorded in the HC-019 Resolution |
| SP-C2 duplicated JSDoc | Same as S1 |

Verified after remediation: `bun run check` green (typecheck, lint, knip,
full suite with coverage); ollama-code's map still reads "Google Gemini API"
+ "Ollama" (the comment guard does not regress the real references, which sit
in code lines).
