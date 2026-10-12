interface Cookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  expires: number | undefined;
}

/** Minimal RFC 6265 cookie jar: enough to carry SSO session cookies from login to MFA. */
export class CookieJar {
  private readonly cookies = new Map<string, Cookie>();

  constructor(private readonly now: () => number = Date.now) {}

  store(url: string, setCookieHeaders: readonly string[]): void {
    const host = new URL(url).hostname.toLowerCase();
    for (const header of setCookieHeaders) {
      const [pair = '', ...attrs] = header.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = host;
      let hostOnly = true;
      let path = '/';
      let expires: number | undefined;
      let foreign = false;
      for (const attr of attrs) {
        const [rawKey = '', ...rest] = attr.split('=');
        const key = rawKey.trim().toLowerCase();
        const val = rest.join('=').trim();
        if (key === 'domain' && val) {
          const d = val.replace(/^\./, '').toLowerCase();
          if (host === d || host.endsWith(`.${d}`)) {
            domain = d;
            hostOnly = false;
          } else {
            foreign = true;
          }
        } else if (key === 'path' && val.startsWith('/')) {
          path = val;
        } else if (key === 'max-age') {
          const secs = Number.parseInt(val, 10);
          if (Number.isFinite(secs)) expires = this.now() + secs * 1000;
        } else if (key === 'expires' && expires === undefined) {
          const t = Date.parse(val);
          if (Number.isFinite(t)) expires = t;
        }
      }
      // RFC 6265 5.3: a cookie for a domain the response host does not belong to is ignored.
      if (foreign) continue;
      const id = `${domain}|${path}|${name}`;
      if (expires !== undefined && expires <= this.now()) this.cookies.delete(id);
      else this.cookies.set(id, { name, value, domain, hostOnly, path, expires });
    }
  }

  header(url: string): string | undefined {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const now = this.now();
    const parts: string[] = [];
    for (const [id, c] of this.cookies) {
      if (c.expires !== undefined && c.expires <= now) {
        this.cookies.delete(id);
        continue;
      }
      const domainOk = c.hostOnly ? host === c.domain : host === c.domain || host.endsWith(`.${c.domain}`);
      if (domainOk && u.pathname.startsWith(c.path)) parts.push(`${c.name}=${c.value}`);
    }
    return parts.length ? parts.join('; ') : undefined;
  }

  get size(): number {
    return this.cookies.size;
  }
}
