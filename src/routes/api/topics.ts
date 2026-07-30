import type { APIEvent } from "@solidjs/start/server";
import { z } from "zod";
import { isAuthenticated, unauthorized } from "~/lib/auth";
import {
  addTopicPreference,
  removeTopicPreference,
} from "~/lib/store";

const schema = z.object({
  topic: z.string().trim().min(1).max(100),
  reaction: z.enum(["like", "dislike"]),
});

export async function POST({ request }: APIEvent) {
  if (!isAuthenticated(request)) return unauthorized();
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  await addTopicPreference(parsed.data.topic, parsed.data.reaction);
  return Response.json({ updated: true });
}

export async function DELETE({ request }: APIEvent) {
  if (!isAuthenticated(request)) return unauthorized();
  const topic = new URL(request.url).searchParams.get("topic");
  if (!topic) {
    return Response.json({ error: "Missing topic" }, { status: 400 });
  }
  await removeTopicPreference(topic);
  return Response.json({ removed: true });
}
