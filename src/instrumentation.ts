export async function register() {
  // Only the Node.js runtime has a filesystem and a database driver.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootstrap } = await import("@/lib/bootstrap");
    await bootstrap();
  }
}
