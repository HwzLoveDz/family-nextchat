import { handleWorkspaceAccount } from "@/app/family/server/workspace-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export const GET = (request: Request) => handleWorkspaceAccount(request);
export const PATCH = (request: Request) => handleWorkspaceAccount(request);
