import type { APIEvent } from "@solidjs/start/server";
import { z } from "zod";
import { isAuthenticated, unauthorized } from "~/lib/auth";
import { recordTopicRatings } from "~/lib/store";

const schema = z.object({
  articleId: z.string().min(1),
  ratings: z
    .array(
      z.object({
        topic: z.string().min(1).max(100),
        reaction: z.enum(["like", "dislike"]),
      }),
    )
    .max(10),
});

export async function POST({ request }: APIEvent) {
  if (!isAuthenticated(request)) return unauthorized();
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  const state = await recordTopicRatings(
    parsed.data.articleId,
    parsed.data.ratings,
  );
  if (!state) {
    return Response.json({ error: "Article not found" }, { status: 404 });
  }
  return Response.json(state);
}
