import { NextRequest, NextResponse } from "next/server";
import { isFamilyMode } from "@/app/family/enabled";
import { legacyApiDisabled } from "@/app/api/legacy-disabled";

// This private deployment does not use arbitrary OpenAPI/plugin endpoints.
// Deny them here as well as in the router so a future route cannot accidentally
// restore caller-controlled destinations or forward the deployment's API key.
export async function handle(
  _req: NextRequest,
  _context: { params: { path: string[] } },
) {
  if (isFamilyMode()) return legacyApiDisabled();
  return NextResponse.json(
    { error: true, msg: "Generic API proxy is disabled." },
    { status: 403 },
  );
}
