/** A second package deliberately sharing @mini/toolkit's name AND its `src`
 * segment (as ollama-code's root and packages/core share a name). Its rooms must
 * not merge into the other toolkit's (HC-015). */
export const extra = 42;
