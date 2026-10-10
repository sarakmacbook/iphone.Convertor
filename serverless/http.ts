/**
 * Small Web-standard (Request/Response) helpers shared by the Vercel functions.
 */

import { EnvError, loadVercelEnv, type VercelEnv } from "./env.js";

export function corsHeaders(request: Request, corsOrigin: string, methods: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, X-Api-Key, Authorization",
    "Access-Control-Max-Age": "86400",
  };
  const configured = corsOrigin
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (configured.includes("*")) {
    headers["Access-Control-Allow-Origin"] = "*";
  } else {
    const origin = request.headers.get("origin");
    if (origin && configured.some((allowed) => allowed.toLowerCase() === origin.toLowerCase())) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers.Vary = "Origin";
    }
  }
  return headers;
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

export function jsonError(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return json({ ok: false, error: { code, message } }, status, headers);
}

/** The optional WEB_API_KEY check, same rules as the long-running server. */
export function hasApiKey(request: Request, apiKey: string | undefined): boolean {
  if (!apiKey) return true;
  const url = new URL(request.url);
  const header =
    request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  return (header || url.searchParams.get("key") || "") === apiKey;
}

/**
 * Loads settings, turning a misconfiguration into a readable 500 instead of a
 * crashed function with an empty response.
 */
export function withEnv(handler: (request: Request, env: VercelEnv) => Promise<Response> | Response) {
  return async (request: Request): Promise<Response> => {
    let env: VercelEnv;
    try {
      env = loadVercelEnv();
    } catch (error) {
      if (error instanceof EnvError) {
        console.error("Configuration error:", error.message);
        return jsonError(500, "misconfigured", error.message);
      }
      throw error;
    }
    return handler(request, env);
  };
}
