import { NextRequest, NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db } from "@/db";
import { games } from "@/db/schema";
import { guardRead } from "@/lib/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Lists games. The (potentially huge) asset manifest is deliberately NOT
 * selected here; it is only returned by GET /api/games/[id].
 * Uploads go through POST /api/games/upload + POST /api/games/finalize.
 */
export async function GET(request: NextRequest) {
  const denied = guardRead(request);
  if (denied) return denied;

  try {
    const rows = await db
      .select({
        id: games.id,
        name: games.name,
        originalFilename: games.originalFilename,
        status: games.status,
        progress: games.progress,
        assetCount: games.assetCount,
        totalSize: games.totalSize,
        extractionError: games.extractionError,
        entryPoint: games.entryPoint,
        createdAt: games.createdAt,
      })
      .from(games)
      .orderBy(desc(games.createdAt));
    return NextResponse.json(rows, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Error fetching games:", error);
    return NextResponse.json({ error: "Failed to fetch games" }, { status: 500 });
  }
}
