import type { APIEvent } from "@solidjs/start/server";
import { z } from "zod";
import { isAuthenticated, unauthorized } from "~/lib/auth";
import { readSettings, updateSettings } from "~/lib/store";

const schema = z.object({
  pollIntervalMinutes: z.number().finite().positive(),
  maxItemsPerSource: z.number().int().positive(),
  llmBaseURL: z.string().url(),
  llmModel: z.string().min(1),
  llmApiKey: z.string().optional(),
  generalGuidance: z.string().max(5_000),
});

export async function GET({ request }: APIEvent) {
  if (!isAuthenticated(request)) return unauthorized();
  return Response.json(readSettings());
}

export async function PUT({ request }: APIEvent) {
  if (!isAuthenticated(request)) return unauthorized();
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  return Response.json(updateSettings(parsed.data));
}
