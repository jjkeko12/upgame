import { pgTable, serial, text, timestamp, varchar, jsonb, integer, bigint } from "drizzle-orm/pg-core";

export type AssetType = "image" | "audio" | "video" | "script" | "text" | "font" | "other";

export interface AssetEntry {
  path: string;
  size: number;
  type: AssetType;
}

export const games = pgTable("games", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  originalFilename: varchar("original_filename", { length: 255 }).notNull(),
  uploadPath: text("upload_path").notNull(),
  extractPath: text("extract_path").notNull(),
  assetManifest: jsonb("asset_manifest").$type<Record<string, AssetEntry>>(),
  status: varchar("status", { length: 50 })
    .$type<"uploading" | "extracting" | "ready" | "error">()
    .notNull()
    .default("uploading"),
  /** 0-100 progress of extraction */
  progress: integer("progress").notNull().default(0),
  /** Number of assets extracted so far (live during extraction) */
  assetCount: integer("asset_count").notNull().default(0),
  /** Size of the original uploaded archive in bytes */
  totalSize: bigint("total_size", { mode: "number" }).notNull().default(0),
  /** Error message when status is "error"; a warning (e.g. skipped files) when "ready" */
  extractionError: text("extraction_error"),
  /** Name of the detected entry point (index.html etc.) */
  entryPoint: text("entry_point"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
