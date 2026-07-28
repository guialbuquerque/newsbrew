import type { APIEvent } from "@solidjs/start/server";
import { isAuthenticated, unauthorized } from "~/lib/auth";
import { readSettings, readState } from "~/lib/store";

export async function GET({ request }: APIEvent) {
  if (!isAuthenticated(request)) return unauthorized();
  const state = await readState();
  const settings = readSettings();
  return Response.json({
    ...state,
    ...settings,
  });
}
