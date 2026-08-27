import { Ollama } from "ollama";

const client = new Ollama();

/** Request handler for the standalone service; summarises the body via Ollama. */
export async function handle(request: Request): Promise<Response> {
    const prompt = await request.text();
    const reply = await client.generate({ model: "llama3", prompt });
    return new Response(reply.response);
}
