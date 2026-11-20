import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const exec = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * # The tracing dependency contract
 *
 * These are not tests of behaviour. They are tests of the **installed tree**,
 * because the two ways this tracing setup fails are both invisible at runtime:
 *
 *  1. More than one copy of `import-in-the-middle`, which makes ESM
 *     instrumentation patch a module graph nobody consults. Traces come out
 *     empty. No error, no warning.
 *  2. `instrumentation-fs` appearing in the tree, which patches every
 *     filesystem call in the process and is the single biggest RSS regression
 *     available in this dependency space.
 *
 * Both are properties an unrelated `npm install` can change. Asserting them in
 * CI is the only way the comment in observability/tracing.ts stays true.
 */

describe('tracing dependency contract', () => {
  it('resolves exactly one copy of import-in-the-middle', async () => {
    /**
     * `npm ls --all --json` over the whole tree. The nested-copy signal is a
     * `node_modules/import-in-the-middle` directory *below* the root one —
     * `npm ls` reports those as a full entry rather than `deduped`.
     *
     * Read from `npm ls` rather than by walking the filesystem because a
     * physically nested directory can still be the same resolved package via a
     * link, and it is the resolution that matters.
     */
    const { stdout } = await exec('npm', ['ls', '--all', '--json', 'import-in-the-middle'], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });

    const versions = new Set<string>();

    const walk = (node: unknown): void => {
      if (typeof node !== 'object' || node === null) return;
      const deps = (node as { dependencies?: Record<string, unknown> }).dependencies;
      if (!deps) return;

      for (const [name, child] of Object.entries(deps)) {
        if (typeof child !== 'object' || child === null) continue;
        const entry = child as { version?: string; resolved?: string };

        // A `deduped` entry carries no `version`, which is exactly the shape
        // that proves it points at the single root copy.
        if (name === 'import-in-the-middle' && entry.version !== undefined) {
          versions.add(entry.version);
        }
        walk(child);
      }
    };

    walk(JSON.parse(stdout));

    expect(
      versions.size,
      `import-in-the-middle resolved to ${String(versions.size)} distinct copies ` +
        `(${[...versions].join(', ')}). More than one means ESM instrumentation ` +
        `silently produces empty traces — see apps/api/src/observability/tracing.ts.`,
    ).toBe(1);
  });

  it('does not depend on instrumentation-fs or auto-instrumentations-node', async () => {
    const manifest = JSON.parse(
      await readFile(resolve(repoRoot, 'apps/api/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };

    const all = { ...manifest.dependencies, ...manifest.devDependencies };

    expect(all['@opentelemetry/instrumentation-fs']).toBeUndefined();
    expect(all['@opentelemetry/auto-instrumentations-node']).toBeUndefined();
  });

  it('pins every opentelemetry dependency to an exact version', async () => {
    /**
     * The OpenTelemetry JS packages move fast and their cross-package peer
     * ranges are strict. A caret range is how a working trace pipeline becomes
     * an empty one after an unrelated install, so `.npmrc` sets
     * `save-exact=true` — and this asserts nobody hand-edited a range back in.
     */
    const manifest = JSON.parse(
      await readFile(resolve(repoRoot, 'apps/api/package.json'), 'utf8'),
    ) as { dependencies?: Record<string, string> };

    const otel = Object.entries(manifest.dependencies ?? {}).filter(([name]) =>
      name.startsWith('@opentelemetry/'),
    );

    expect(otel.length).toBeGreaterThan(0);

    for (const [name, range] of otel) {
      expect(range, `${name} must be pinned exact, not "${range}"`).toMatch(
        /^\d+\.\d+\.\d+(-[\w.]+)?$/,
      );
    }
  });
});
