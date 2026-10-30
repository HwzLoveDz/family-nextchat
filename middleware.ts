import { NextRequest, NextResponse } from "next/server";
import { isFamilyMode, PRIVATE_API_HEADERS } from "./app/family/enabled";
import { legacyApiDisabled } from "./app/api/legacy-disabled";

export function middleware(request: NextRequest) {
  if (!isFamilyMode()) return NextResponse.next();

  const path = request.nextUrl.pathname;
  if (
    path === "/sharegpt" ||
    path === "/google-fonts" ||
    path.startsWith("/google-fonts/")
  ) {
    return legacyApiDisabled();
  }
  const isApi = path === "/api" || path.startsWith("/api/");
  const isFamilyApi = path === "/api/family" || path.startsWith("/api/family/");
  const isAuthApi = path === "/api/auth" || path.startsWith("/api/auth/");
  if (isApi && !isFamilyApi && !isAuthApi) return legacyApiDisabled();

  const isFrameworkAsset = path === "/_next" || path.startsWith("/_next/");
  const isPageGet =
    request.method === "GET" &&
    !isApi &&
    !isFrameworkAsset &&
    (request.headers.get("sec-fetch-dest") === "document" ||
      request.headers.get("accept")?.includes("text/html") ||
      !path.split("/").pop()?.includes("."));
  if (process.env.VERCEL_ENV === "production" && isPageGet) {
    let canonical: URL;
    try {
      canonical = new URL(process.env.BETTER_AUTH_URL ?? "");
      if (
        canonical.protocol !== "https:" ||
        canonical.username ||
        canonical.password ||
        canonical.pathname !== "/" ||
        canonical.search ||
        canonical.hash
      ) {
        throw new Error("Invalid canonical origin");
      }
    } catch {
      return NextResponse.json(
        { error: "家庭站点地址尚未配置。", code: "AUTH_NOT_CONFIGURED" },
        { status: 503, headers: PRIVATE_API_HEADERS },
      );
    }
    if (request.nextUrl.hostname !== canonical.hostname) {
      // Assign path/search separately. A caller's //host path, query parameters
      // or forwarded headers must never become the redirect's trusted origin.
      const destination = new URL(canonical.origin);
      destination.pathname = path;
      destination.search = request.nextUrl.search;
      return NextResponse.redirect(destination, {
        status: 307,
        headers: PRIVATE_API_HEADERS,
      });
    }
  }

  // Next reads this request CSP and applies its nonce to framework/hydration
  // scripts. The family layout opts into dynamic rendering so it is never
  // served with a nonce from another request's static HTML.
  const nonce = btoa(crypto.randomUUID());
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${
      process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""
    }`,
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    // Allow the existing same-origin worker to update to the cleanup-only
    // version. The family UI does not register a new worker or private cache.
    "worker-src 'self'",
    "media-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  const responseCsp = isApi
    ? PRIVATE_API_HEADERS["Content-Security-Policy"]
    : csp;
  requestHeaders.set("Content-Security-Policy", responseCsp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  for (const [key, value] of Object.entries(PRIVATE_API_HEADERS)) {
    response.headers.set(key, value);
  }
  if (!isApi)
    response.headers.set(
      "Permissions-Policy",
      "camera=(), microphone=(self), geolocation=()",
    );
  response.headers.set("Content-Security-Policy", responseCsp);
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
