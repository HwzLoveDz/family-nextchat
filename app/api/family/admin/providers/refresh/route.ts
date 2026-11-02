import { handleProviderAdmin } from "@/app/family/server/provider-admin";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;
export const POST = (request: Request) => handleProviderAdmin(request, true);
