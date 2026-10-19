import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { games } from "@/db/schema";
import { guardMutation, guardRead } from "@/lib/security";
import { cleanupGameFiles } from "@/lib/utils";
import { activeJobs } from "@/lib/jobs";
import { invalidateServeInfo } from "@/lib/serve-cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = guardRead(request);
  if (denied) return denied;

  try {
    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: "Game not found" }, { status: 404 });

    const rows = await db.select().from(games).where(eq(games.id, id)).limit(1);
    if (rows.length === 0) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }
    return NextResponse.json(rows[0], { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Error fetching game:", error);
    return NextResponse.json({ error: "Failed to fetch game" }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const denied = guardMutation(request);
  if (denied) return denied;

  try {
    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: "Game not found" }, { status: 404 });

    // Stop a still-running extraction first so it cannot recreate files.
    activeJobs.get(id)?.abort();

    const deleted = await db.delete(games).where(eq(games.id, id)).returning();
    if (deleted.length === 0) {
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }
    invalidateServeInfo(id);

    // Remove the uploaded archive and the extracted asset tree
    await cleanupGameFiles(deleted[0].uploadPath, deleted[0].extractPath);

    return NextResponse.json({ message: "Game deleted successfully" });
  } catch (error) {
    console.error("Error deleting game:", error);
    return NextResponse.json({ error: "Failed to delete game" }, { status: 500 });
  }
}
