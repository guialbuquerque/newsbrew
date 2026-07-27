import type { APIEvent } from "@solidjs/start/server";
import { z } from "zod";
import { updatePreferences } from "~/lib/store";

const schema = z.object({
  minimumScore: z.number().min(0).max(100),
});

export async function PUT({ request }: APIEvent) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  return Response.json(await updatePreferences(parsed.data));
}
