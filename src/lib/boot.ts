const holder = globalThis as unknown as { __wdBoot?: Promise<void> };

/** 服务启动时补齐桌面密码，并拉起 xfce4 + tigervncserver。幂等。 */
export function bootApp() {
  holder.__wdBoot ??= (async () => {
    try {
      const { ensureAuthTables, isDesktopPasswordSet, setDesktopPassword } = await import("./auth");
      await ensureAuthTables();
      if (process.env.DESKTOP_PASSWORD && !(await isDesktopPasswordSet())) {
        await setDesktopPassword(process.env.DESKTOP_PASSWORD, null);
        console.log("[deploy] 已初始化桌面访问密码");
      }
    } catch (e) {
      console.error("[deploy] 初始化桌面密码失败", e);
    }
    const { keepVncAlive } = await import("./vnc-launch");
    keepVncAlive();
  })().catch((e) => {
    holder.__wdBoot = undefined;
    console.error("[deploy] 启动补全失败", e);
  });
  return holder.__wdBoot;
}
