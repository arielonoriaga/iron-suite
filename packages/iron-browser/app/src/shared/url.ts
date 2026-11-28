function isValidIpv4Host(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

function isValidPort(portStr: string | undefined): boolean {
  if (portStr === undefined) return true;
  if (!/^\d{1,5}$/.test(portStr)) return false;
  const port = Number(portStr);
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * Strictly restricts untrusted/user/MCP navigation URLs to `http:`, `https:`, and `about:blank`.
 * Rejects `file:`, `data:`, `javascript:`, `chrome:`, `devtools:`, etc.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.toLowerCase() === 'about:blank') {
    return 'about:blank';
  }

  let candidate = trimmed;

  const ipv6Match = trimmed.match(/^(\[[0-9a-fA-F:]+\])(?::(\d{1,5}))?(?:[/?#].*)?$/);
  const localhostMatch = trimmed.match(
    /^(?:[a-zA-Z0-9-]+\.)*localhost(?::(\d{1,5}))?(?:[/?#].*)?$/i,
  );
  const ipv4Match = trimmed.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::(\d{1,5}))?(?:[/?#].*)?$/);
  const dotlessHostPortMatch = trimmed.match(/^[a-zA-Z0-9-]+:(\d{1,5})(?:[/?#].*)?$/);
  const lanHostMatch = trimmed.match(
    /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.(?:local|lan|home|internal|localdomain|home\.arpa)(?::(\d{1,5}))?(?:[/?#].*)?$/i,
  );
  const tailscaleHostPortMatch = trimmed.match(
    /^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.ts\.net:(\d{1,5})(?:[/?#].*)?$/i,
  );

  if (ipv6Match && isValidPort(ipv6Match[2])) {
    candidate = `http://${trimmed}`;
  } else if (localhostMatch && isValidPort(localhostMatch[1])) {
    candidate = `http://${trimmed}`;
  } else if (ipv4Match && isValidIpv4Host(ipv4Match[1]!) && isValidPort(ipv4Match[2])) {
    candidate = `http://${trimmed}`;
  } else if (dotlessHostPortMatch && isValidPort(dotlessHostPortMatch[1])) {
    candidate = `http://${trimmed}`;
  } else if (lanHostMatch && isValidPort(lanHostMatch[1])) {
    candidate = `http://${trimmed}`;
  } else if (
    tailscaleHostPortMatch &&
    isValidPort(tailscaleHostPortMatch[1]) &&
    tailscaleHostPortMatch[1] !== '443' &&
    tailscaleHostPortMatch[1] !== '8443'
  ) {
    candidate = `http://${trimmed}`;
  } else if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) &&
    !/^[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+:\d{1,5}(?:$|[/?#])/.test(trimmed)
  ) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`Invalid URL: ${trimmed}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(
        `Unsupported URL scheme "${parsed.protocol}" (only http:, https:, and about:blank are allowed)`,
      );
    }
    return parsed.toString();
  } else {
    const publicDomainMatch = trimmed.match(
      /^(?!\d+(?:\.\d+)+$)[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+(?::(\d{1,5}))?(?:[/?#].*)?$/i,
    );
    if (publicDomainMatch && isValidPort(publicDomainMatch[1])) {
      candidate = `https://${trimmed}`;
    } else {
      candidate = `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(`Invalid URL: ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${parsed.protocol}"`);
  }
  return parsed.toString();
}
