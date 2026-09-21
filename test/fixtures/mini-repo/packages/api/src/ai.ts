/** Talks to an OpenAI-compatible endpoint to summarise a message. */
import OpenAI from "openai";

// The endpoint falls back to a local Ollama server, OpenAI-compatible style
// (the ollama-code shape): the SDK alone does not name the real backend.
const client = new OpenAI({ baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1" });

export async function summarise(text: string): Promise<string> {
    const result = await client.responses.create({ model: "gpt-5", input: text });
    return result.output_text ?? "";
}
