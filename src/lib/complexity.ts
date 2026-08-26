// Per-file cyclomatic complexity for building heights and footprints
// (HEURISTICS.md rule O6, feeding O5 and M11).

import { join } from "node:path";
import { readText } from "./read.ts";

type ComplexityStats = { sum: number; max: number };

// McCabe cyclomatic complexity from the TypeScript compiler API when it is
// installed (per function: 1 + decision points attributed to the innermost
// enclosing function; logical operators and non-default switch cases count;
// top-level statements form an implicit function). A file carries the sum
// and the max function complexity. Falls back to a decision-point regex
// (sum == max, no function attribution) when typescript is unavailable.
const COMPLEXITY_FALLBACK_PATTERN = /\bif\s*\(|\bfor\s*(?:\(|await)|\bwhile\s*\(|\bcase\s|\bcatch\b|&&|\|\||\?\?/g;

export type ComplexityCompiler = typeof import("typescript");

export type ComplexityScanner = {
    fileComplexity: (file: string) => number;
    fileMaxFunctionComplexity: (file: string) => number;
};

/**
 * Loads the TypeScript compiler for per-function complexity attribution. The
 * import is a system seam: `typescript` is only a devDependency, and an ESM
 * interop shape that resolves without exposing the compiler API is not an
 * error but a signal to use the regex fallback. Resolving successfully is
 * therefore not enough — the result is probed for the API actually used.
 *
 * @param importCompiler - Loader for the compiler module, injectable so a
 *   test can supply an unusable or failing module.
 * @returns The compiler when it exposes a usable API, otherwise null.
 */
export async function loadComplexityCompiler(
    importCompiler: () => Promise<{ default?: unknown }> = () => import("typescript"),
): Promise<ComplexityCompiler | null> {
    try {
        const loaded = (await importCompiler()).default as Partial<ComplexityCompiler> | undefined;
        if (typeof loaded?.createSourceFile !== "function" || loaded.ScriptTarget === undefined) return null;
        return loaded as ComplexityCompiler;
    } catch {
        return null;
    }
}

/**
 * Creates a cached per-file complexity scanner rooted at the repo.
 *
 * @param repo - Absolute path of the repository being mapped; files handed
 *   to the scanner are read relative to it.
 * @param ts - The TypeScript compiler from {@link loadComplexityCompiler}, or
 *   null to use the decision-point regex fallback.
 * @returns Accessors for a file's summed complexity (all functions) and its
 *   worst single-function complexity, memoised per file.
 */
export function createComplexityScanner(repo: string, ts: ComplexityCompiler | null): ComplexityScanner {
    const complexityCache = new Map<string, ComplexityStats>();
    /**
     * Computes (and caches) the file's complexity stats: per-function McCabe
     * values via the compiler API when available, else the regex fallback.
     *
     * @param file - Repo-relative path of the source file.
     * @returns The file's summed and worst-single-function complexity.
     */
    function fileComplexityStats(file: string): ComplexityStats {
        const cached = complexityCache.get(file);
        if (cached !== undefined) return cached;
        const text = readText(join(repo, file));
        let stats: ComplexityStats;
        if (ts) {
            const compiler = ts;
            const sourceFile = compiler.createSourceFile(file, text, compiler.ScriptTarget.Latest, true);
            const functionKinds = new Set([
                compiler.SyntaxKind.FunctionDeclaration,
                compiler.SyntaxKind.FunctionExpression,
                compiler.SyntaxKind.ArrowFunction,
                compiler.SyntaxKind.MethodDeclaration,
                compiler.SyntaxKind.Constructor,
                compiler.SyntaxKind.GetAccessor,
                compiler.SyntaxKind.SetAccessor,
            ]);
            const decisionKinds = new Set([
                compiler.SyntaxKind.IfStatement,
                compiler.SyntaxKind.ForStatement,
                compiler.SyntaxKind.ForInStatement,
                compiler.SyntaxKind.ForOfStatement,
                compiler.SyntaxKind.WhileStatement,
                compiler.SyntaxKind.DoStatement,
                compiler.SyntaxKind.ConditionalExpression,
                compiler.SyntaxKind.CatchClause,
                compiler.SyntaxKind.CaseClause,
            ]);
            const logicalOperators = new Set([
                compiler.SyntaxKind.AmpersandAmpersandToken,
                compiler.SyntaxKind.BarBarToken,
                compiler.SyntaxKind.QuestionQuestionToken,
            ]);
            const topLevel = { complexity: 1 };
            const finished: { complexity: number }[] = [];
            const stack = [topLevel];
            /**
             * Walks the AST attributing each decision point to the innermost
             * enclosing function (the top of the stack); entering a function
             * node pushes a fresh counter starting at 1.
             *
             * @param node - The AST node being visited.
             */
            const visit = (node: import("typescript").Node): void => {
                if (functionKinds.has(node.kind)) {
                    stack.push({ complexity: 1 });
                    compiler.forEachChild(node, visit);
                    const popped = stack.pop();
                    if (popped) finished.push(popped);
                    return;
                }
                const operatorKind =
                    node.kind === compiler.SyntaxKind.BinaryExpression
                        ? (node as import("typescript").BinaryExpression).operatorToken?.kind
                        : undefined;
                if (
                    decisionKinds.has(node.kind) ||
                    (operatorKind !== undefined && logicalOperators.has(operatorKind))
                ) {
                    const top = stack[stack.length - 1];
                    if (top) top.complexity += 1;
                }
                compiler.forEachChild(node, visit);
            };
            visit(sourceFile);
            finished.push(topLevel);
            const values = finished.map((f) => f.complexity);
            stats = { sum: values.reduce((total, v) => total + v, 0), max: Math.max(...values) };
        } else {
            const total = 1 + (text.match(COMPLEXITY_FALLBACK_PATTERN)?.length ?? 0);
            stats = { sum: total, max: total };
        }
        complexityCache.set(file, stats);
        return stats;
    }
    return {
        fileComplexity: (file) => fileComplexityStats(file).sum,
        fileMaxFunctionComplexity: (file) => fileComplexityStats(file).max,
    };
}
