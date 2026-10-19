export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { installBrowserWs } = await import("./lib/browser-ws");
  installBrowserWs();

  const { bootApp } = await import("./lib/boot");
  void bootApp();
}
