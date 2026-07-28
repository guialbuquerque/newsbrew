import type { APIEvent } from "@solidjs/start/server";
import {
  authenticate,
  authStatus,
  configureAccessToken,
  logout,
} from "~/lib/auth";

function errorResponse(error: unknown) {
  return Response.json(
    { error: error instanceof Error ? error.message : "Authentication failed" },
    { status: 400 },
  );
}

export async function GET({ request }: APIEvent) {
  return Response.json(authStatus(request));
}

export async function POST({ request }: APIEvent) {
  const action = new URL(request.url).searchParams.get("action");
  try {
    if (action === "authenticate") return authenticate(request);
    if (action === "configure") return configureAccessToken(request);
    if (action === "logout") return logout(request);
    return Response.json({ error: "Unknown auth action" }, { status: 404 });
  } catch (error) {
    return errorResponse(error);
  }
}
