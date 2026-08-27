/** Talks to the OpenAI API to summarise a message. */
import OpenAI from "openai";

const client = new OpenAI();

export async function summarise(text: string): Promise<string> {
    const result = await client.responses.create({ model: "gpt-5", input: text });
    return result.output_text ?? "";
}
