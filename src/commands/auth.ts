import { z } from "zod";
import { parseFlags } from "../args.ts";
import { getAccessToken } from "../auth.ts";

const meResponse = z.object({ data: z.object({ id: z.string(), username: z.string() }) });

export async function run(argv: string[]): Promise<void> {
  parseFlags("auth", argv, {});
  const token = await getAccessToken();
  const res = await fetch("https://api.x.com/2/users/me", { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET /2/users/me failed (HTTP ${res.status})`);
  const { data } = meResponse.parse(await res.json());
  console.log(`Logged in as @${data.username} (${data.id})`);
}
