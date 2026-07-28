import {
  accessTokenRequired,
  authSessionIsValid,
  createAuthSession,
  deleteAuthSession,
  setAccessToken,
  verifyAccessToken,
} from "./store.ts";

const sessionCookie = "newsbrew_session";

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return undefined;
}

function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  return authorization.slice("Bearer ".length);
}

function sameOriginMutation(request: Request) {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const origin = request.headers.get("origin");
  return !origin || origin === new URL(request.url).origin;
}

export function isAuthenticated(request: Request) {
  if (!sameOriginMutation(request)) return false;
  if (!accessTokenRequired()) return true;
  const bearer = bearerToken(request);
  if (bearer && verifyAccessToken(bearer)) return true;
  return authSessionIsValid(cookieValue(request, sessionCookie));
}

export function unauthorized() {
  return Response.json({ error: "Access token required" }, { status: 401 });
}

export function authStatus(request: Request) {
  return {
    required: accessTokenRequired(),
    authenticated: isAuthenticated(request),
  };
}

export async function authenticate(request: Request) {
  const body = (await request.json()) as { accessToken?: unknown };
  if (typeof body.accessToken !== "string") {
    return Response.json({ error: "Access token is required" }, { status: 400 });
  }
  if (accessTokenRequired() && !verifyAccessToken(body.accessToken)) {
    return Response.json({ error: "Incorrect access token" }, { status: 401 });
  }
  return authenticatedResponse(request);
}

export async function configureAccessToken(request: Request) {
  if (!isAuthenticated(request)) return unauthorized();
  const body = (await request.json()) as { accessToken?: unknown };
  if (typeof body.accessToken !== "string") {
    return Response.json(
      { error: "Access token must be a string" },
      { status: 400 },
    );
  }
  if (body.accessToken.length > 512) {
    return Response.json(
      { error: "Access token must be at most 512 characters" },
      { status: 400 },
    );
  }
  const required = setAccessToken(body.accessToken);
  if (!required) {
    return Response.json(
      { required: false, authenticated: true },
      { headers: { "Set-Cookie": expiredSessionCookie() } },
    );
  }
  return authenticatedResponse(request);
}

function authenticatedResponse(request: Request) {
  const session = createAuthSession();
  const secure = new URL(request.url).protocol === "https:";
  return Response.json(
    { required: accessTokenRequired(), authenticated: true },
    {
      headers: {
        "Set-Cookie": [
          `${sessionCookie}=${encodeURIComponent(session.token)}`,
          "Path=/",
          "HttpOnly",
          "SameSite=Strict",
          secure ? "Secure" : "",
          `Expires=${session.expiresAt.toUTCString()}`,
        ]
          .filter(Boolean)
          .join("; "),
      },
    },
  );
}

function expiredSessionCookie() {
  return `${sessionCookie}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export function logout(request: Request) {
  deleteAuthSession(cookieValue(request, sessionCookie));
  return Response.json(
    { ok: true },
    { headers: { "Set-Cookie": expiredSessionCookie() } },
  );
}
