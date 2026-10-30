// This fork is always a family private site in production. Only local
// development/tests may opt into legacy behavior; a missing or mistyped family
// flag must never restore the shared access-code/BYOK routes after deployment.
export function isFamilyMode(): boolean {
  return (
    process.env.NODE_ENV === "production" || process.env.FAMILY_MODE === "1"
  );
}

export const PRIVATE_API_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
} as const;
