// API/middleware response factory. Keep next/server out of the shared, pure
// family-mode helper: legacy client utilities also inspect that mode.
import { NextResponse } from "next/server";
import { PRIVATE_API_HEADERS } from "../family/enabled";

export function legacyApiDisabled() {
  return NextResponse.json(
    { error: true, msg: "Legacy APIs are disabled in family mode." },
    { status: 403, headers: PRIVATE_API_HEADERS },
  );
}
