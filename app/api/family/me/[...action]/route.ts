import { handleWorkspaceAccount } from "@/app/family/server/workspace-account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

async function handle(
  request: Request,
  context: { params: Promise<{ action: string[] }> },
) {
  return handleWorkspaceAccount(request, (await context.params).action);
}
export { handle as GET, handle as DELETE, handle as POST };
