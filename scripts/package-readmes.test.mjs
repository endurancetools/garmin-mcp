import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { absolutize, appReadme, expectedReadmes, relativeLinks, REPO, RAW, staleReadmes } from './package-readmes.mjs';

describe('package-readmes', () => {
  it('makes relative links and images absolute, leaves absolute ones and anchors alone', () => {
    expect(absolutize('DEVELOPMENT.md')).toBe(`${REPO}/blob/main/DEVELOPMENT.md`);
    expect(absolutize('LICENSE')).toBe(`${REPO}/blob/main/LICENSE`);
    expect(absolutize('./docs/coverage.md#activities')).toBe(`${REPO}/blob/main/docs/coverage.md#activities`);
    expect(absolutize('docs/')).toBe(`${REPO}/tree/main/docs/`);
    expect(absolutize('packages/auth')).toBe(`${REPO}/tree/main/packages/auth`);
    expect(absolutize('docs/assets/images/demo.gif')).toBe(`${RAW}/docs/assets/images/demo.gif`);
    expect(absolutize('https://example.com/a.md')).toBe('https://example.com/a.md');
    expect(absolutize('#tools')).toBe('#tools');
    expect(absolutize('mailto:a@b.c')).toBe('mailto:a@b.c');

    const text = [
      '[![CI](badge.svg)](docs/ci.md) [x](LICENSE "MIT") <img src="docs/a.png" alt="a"> [y](#tools)',
      '[ref]: CHANGELOG.md',
    ].join('\n');
    expect(relativeLinks(text)).toEqual(['badge.svg', 'docs/ci.md', 'LICENSE', 'docs/a.png', 'CHANGELOG.md']);
    expect(relativeLinks(appReadme(text))).toEqual([]);
    expect(appReadme(text)).toContain(`[x](${REPO}/blob/main/LICENSE "MIT")`);
  });

  it('gives every published package a README with absolute links only', () => {
    const readmes = expectedReadmes();
    expect([...readmes.keys()]).toEqual([
      'apps/mcp-server',
      'apps/cli',
      'packages/analytics',
      'packages/auth',
      'packages/client',
      'packages/config',
      'packages/domain',
      'packages/store',
    ]);
    for (const [dir, text] of readmes) expect(relativeLinks(text), dir).toEqual([]);
    const root = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readmes.get('apps/mcp-server')).toBe(appReadme(root));
    expect(readmes.get('packages/auth')).toContain('npx -y garmin-mcp-server');
  });

  it('committed package READMEs match the root README (run node scripts/package-readmes.mjs)', () => {
    expect(staleReadmes()).toEqual([]);
  });
});
