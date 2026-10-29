import { NextRequest, NextResponse } from "next/server";

// This private deployment does not use arbitrary OpenAPI/plugin endpoints.
// Deny them here as well as in the router so a future route cannot accidentally
// restore caller-controlled destinations or forward the deployment's API key.
export async function handle(
  _req: NextRequest,
  _context: { params: { path: string[] } },
) {
  return NextResponse.json(
    { error: true, msg: "Generic API proxy is disabled." },
    { status: 403 },
  );
}
