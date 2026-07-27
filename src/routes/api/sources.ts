import type { APIEvent } from "@solidjs/start/server";
import { z } from "zod";
import { addSource, removeSource } from "~/lib/store";
import { stableId } from "~/lib/utils";

const addSchema = z.object({
  name: z.string().min(2).max(100),
  url: z.string().url(),
});

export async function POST({ request }: APIEvent) {
  const parsed = addSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }
  return Response.json(
    await addSource({
      id: stableId(`${parsed.data.name}:${parsed.data.url}`),
      ...parsed.data,
      enabled: true,
    }),
  );
}

export async function DELETE({ request }: APIEvent) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing source id" }, { status: 400 });
  return Response.json(await removeSource(id));
}
