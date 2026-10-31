import { z } from "zod";
import type { AiProvider } from "./config.ts";
import { getConfig } from "./config.ts";

const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 1000; // 1s, 2s, 4s, 8s

export interface AiSettings {
  provider: AiProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

/** What classify needs from the model: one JSON object back for a system + user message. */
export interface JsonChat {
  completeJson(system: string, user: string): Promise<unknown>;
}

export interface ChatClientDeps {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The API answered, but not with usable JSON (bad JSON, truncated, refusal). Safe to retry the batch. */
export class AiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiResponseError";
  }
}

/** A non-retryable HTTP error from the AI API. The message never contains the API key. */
export class AiApiError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(`AI request failed (HTTP ${status})${detail ? `: ${detail}` : ""}`);
    this.name = "AiApiError";
    this.status = status;
  }
}

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.string().nullable().optional(),
        message: z.object({ content: z.string().nullable().optional(), refusal: z.string().nullable().optional() }),
      }),
    )
    .min(1),
});

const errorBodySchema = z.object({ error: z.object({ message: z.string().optional() }).optional() });

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * OpenAI-compatible /chat/completions over fetch (OpenAI and xAI share it).
 *
 * Request shape, checked against OpenAI's docs for the GPT-6 family (Luna, Terra): `reasoning_effort: "none"` is supported
 * (and its default); temperature is left out; JSON mode (`response_format: json_object`) is used instead of
 * strict Structured Outputs so the same call also works on xAI. Output is validated with zod by the caller.
 * `reasoning_effort` is only sent to OpenAI: other providers may reject the parameter.
 */
export function createChatClient(settings: AiSettings = getConfig().ai, deps: ChatClientDeps = {}): JsonChat {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? realSleep;
  const redact = (text: string) =>
    text.replaceAll(settings.apiKey, "[redacted]").replace(/\b(?:sk|xai)-[\w*.-]{6,}/g, "[redacted]");

  return {
    async completeJson(system, user) {
      // JSON mode requires the word "JSON" to appear in the messages; the system prompt says it.
      const body = JSON.stringify({
        model: settings.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
        ...(settings.provider === "openai" ? { reasoning_effort: "none" } : {}),
      });

      for (let attempt = 1; ; attempt++) {
        let res: Response | undefined;
        let failure = "";
        try {
          res = await doFetch(`${settings.baseUrl}/chat/completions`, {
            method: "POST",
            headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
            body,
          });
        } catch (err) {
          failure = `network error (${err instanceof Error ? err.message : "unknown"})`;
        }

        if (res?.ok) return parseCompletion(await res.json().catch(() => undefined));

        let retryAfterMs = 0;
        if (res) {
          const errBody = errorBodySchema.safeParse(await res.json().catch(() => undefined));
          const detail = errBody.success ? redact(errBody.data.error?.message ?? "") : "";
          if (res.status !== 429 && res.status < 500) throw new AiApiError(res.status, detail);
          failure = `HTTP ${res.status}${detail ? `: ${detail}` : ""}`;
          retryAfterMs = Number(res.headers.get("retry-after")) * 1000 || 0;
        }

        if (attempt >= MAX_TRIES) throw new Error(`AI request failed after ${MAX_TRIES} tries (${failure})`);
        const delay = Math.max(BACKOFF_BASE_MS * 2 ** (attempt - 1), retryAfterMs);
        console.error(`AI request failed (${failure}); retrying in ${Math.ceil(delay / 1000)}s`);
        await sleep(delay);
      }
    },
  };
}

function parseCompletion(raw: unknown): unknown {
  const parsed = completionSchema.safeParse(raw);
  if (!parsed.success) throw new AiResponseError("unexpected response shape from the AI API");
  const choice = parsed.data.choices[0]!;
  if (choice.message.refusal) throw new AiResponseError("the model refused the request");
  if (choice.finish_reason === "length") throw new AiResponseError("the model response was cut off (length)");
  const content = choice.message.content;
  if (!content) throw new AiResponseError("the model returned no content");
  try {
    return JSON.parse(content);
  } catch {
    throw new AiResponseError("the model did not return valid JSON");
  }
}
