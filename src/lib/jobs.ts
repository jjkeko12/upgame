/**
 * Registry of in-flight extraction jobs, keyed by game id. Lets DELETE cancel
 * an extraction that is still running. Stored on globalThis so it survives
 * Next.js dev-mode module reloads.
 */
const g = globalThis as typeof globalThis & {
  __gameExtractJobs?: Map<number, AbortController>;
};

export const activeJobs: Map<number, AbortController> = (g.__gameExtractJobs ??= new Map());
