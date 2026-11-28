export interface OzoneSwitchConfig {
  explicitOzonePlatform: string | null;
  hasDisplayEnv: boolean;
  isHeadlessOzone: boolean;
  hasOverrideScreenSize: boolean;
  switches: Array<[string, string?]>;
}

export function extractOzonePlatformArg(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--ozone-platform=')) {
      const val = arg.slice('--ozone-platform='.length).trim();
      if (val && !val.startsWith('-')) return val;
    } else if (arg === '--ozone-platform' && i + 1 < argv.length) {
      const val = (argv[i + 1] ?? '').trim();
      if (val && !val.startsWith('-')) return val;
    }
  }
  return null;
}

export function resolveOzoneSwitchConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  isSmokeBoot: boolean,
): OzoneSwitchConfig {
  const explicitOzonePlatform = extractOzonePlatformArg(argv);
  const hasDisplayEnv = Boolean(env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim());
  const isHeadlessOzone =
    explicitOzonePlatform === 'headless' || (!explicitOzonePlatform && !hasDisplayEnv);
  const hasOverrideScreenSize = argv.some((a) => a.startsWith('--ozone-override-screen-size'));

  const switches: Array<[string, string?]> = [];
  if (isHeadlessOzone) {
    if (!explicitOzonePlatform) {
      switches.push(['ozone-platform', 'headless']);
    }
    if (!hasOverrideScreenSize) {
      switches.push(['ozone-override-screen-size', '1480,920']);
    }
    switches.push(['enable-features', 'UseOzonePlatform']);
  } else {
    if (!explicitOzonePlatform) {
      switches.push(['ozone-platform-hint', 'auto']);
    }
    switches.push(['enable-features', 'UseOzonePlatform,WaylandWindowDecorations']);
  }

  switches.push(['disable-backgrounding-occluded-windows']);
  if (isSmokeBoot) {
    switches.push(['disable-renderer-backgrounding']);
    switches.push(['disable-background-timer-throttling']);
  }

  return {
    explicitOzonePlatform,
    hasDisplayEnv,
    isHeadlessOzone,
    hasOverrideScreenSize,
    switches,
  };
}
