import { useMemo, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { marked } from 'marked';
import { Card, CardBody, CardHeader } from '@/components/ui/primitives';
import { cn } from '@/lib/cn';

export const Route = createFileRoute('/lab/evidence')({ component: Evidence });

/**
 * # The Evidence page
 *
 * ## The files are bundled, not fetched
 *
 * `import.meta.glob` with `?raw` inlines `docs/evidence/*.md` into the bundle
 * at **build time**. The alternative — an API endpoint that reads the docs
 * directory — would be a file-read endpoint taking a path from a URL, which is
 * a path-traversal hazard for the sake of avoiding a build step.
 *
 * It also means the evidence shown is the evidence that was committed when the
 * app was built, which is the correct coupling: these documents and the code
 * they measure ship together or the numbers describe something else.
 *
 * ## Rendering HTML from markdown
 *
 * `marked` renders to an HTML string that goes through `dangerouslySetInnerHTML`.
 * That is only acceptable because **the input is not user content** — it is
 * markdown from this repository, resolved at build time, with no runtime path by
 * which a visitor can introduce a byte of it. If this page ever rendered
 * markdown that arrived over the network it would need sanitising, and the
 * right answer then is a sanitiser, not a hand-rolled parser.
 *
 * `marked` was chosen over writing a small table parser: a hand-rolled markdown
 * subset is subtly wrong in ways that silently mangle a table, and these tables
 * are the deliverable. It has zero runtime dependencies.
 */
const FILES = import.meta.glob<string>('../../../../../docs/evidence/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

interface Doc {
  slug: string;
  title: string;
  markdown: string;
}

/** `../../../../../docs/evidence/03-concurrency-tradeoff.md` → `03-concurrency-tradeoff`. */
const slugOf = (path: string): string => path.split('/').pop()!.replace(/\.md$/, '');

/** The first `# ` heading, which every evidence file has by template. */
function titleOf(markdown: string, fallback: string): string {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.trim() ?? fallback;
}

const DOCS: Doc[] = Object.entries(FILES)
  .map(([path, markdown]) => {
    const slug = slugOf(path);
    return { slug, title: titleOf(markdown, slug), markdown };
  })
  // `_TEMPLATE` is scaffolding for writing a new evidence file, not evidence.
  .filter((doc) => !doc.slug.startsWith('_'))
  .sort((a, b) => a.slug.localeCompare(b.slug));

function Evidence(): React.JSX.Element {
  const [active, setActive] = useState(DOCS[0]?.slug ?? '');
  const doc = DOCS.find((d) => d.slug === active);

  const html = useMemo(() => {
    if (doc === undefined) return '';
    // `gfm` for tables, which is the whole reason this page exists.
    return marked.parse(doc.markdown, { gfm: true, async: false });
  }, [doc]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-ink-50 text-lg font-semibold">Evidence</h1>
        <p className="text-ink-400 text-xs">
          The committed measurements, rendered from <span className="num">docs/evidence/</span> as
          it stood when this bundle was built.
        </p>
      </div>

      {DOCS.length === 0 ? (
        <Card>
          <CardBody>
            <p className="text-ink-500 text-sm">No evidence files found at build time.</p>
          </CardBody>
        </Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-4">
          <nav className="lg:col-span-1">
            <Card>
              <CardHeader title="Documents" />
              <ul className="p-2">
                {DOCS.map((d) => (
                  <li key={d.slug}>
                    <button
                      type="button"
                      onClick={() => setActive(d.slug)}
                      className={cn(
                        'w-full rounded px-2 py-1.5 text-left text-xs transition-colors',
                        d.slug === active
                          ? 'bg-ink-800 text-ink-50'
                          : 'text-ink-400 hover:bg-ink-900 hover:text-ink-200',
                      )}
                    >
                      <span className="num text-ink-600 block text-[10px]">{d.slug}</span>
                      {d.title}
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          </nav>

          <Card className="lg:col-span-3">
            <CardBody>
              {/*
               * Styled with explicit descendant selectors rather than a
               * typography plugin. The content is a known, small set of
               * elements — headings, paragraphs, tables, code, lists — and
               * naming them is less machinery than adding a dependency whose
               * defaults would then need overriding anyway.
               */}
              <article
                className={cn(
                  'text-ink-300 max-w-none text-sm leading-relaxed',
                  '[&_h1]:text-ink-50 [&_h1]:mb-4 [&_h1]:text-xl [&_h1]:font-semibold',
                  '[&_h2]:text-ink-100 [&_h2]:border-ink-800 [&_h2]:mt-8 [&_h2]:mb-3 [&_h2]:border-b [&_h2]:pb-1.5 [&_h2]:text-base [&_h2]:font-medium',
                  '[&_h3]:text-ink-200 [&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-sm [&_h3]:font-medium',
                  '[&_p]:my-3',
                  '[&_strong]:text-ink-100 [&_strong]:font-semibold',
                  '[&_a]:text-accent [&_a]:underline',
                  '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5',
                  '[&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1 [&_ol]:pl-5',
                  '[&_blockquote]:border-ink-700 [&_blockquote]:text-ink-400 [&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:pl-3',
                  // Inline code and code blocks. `pre code` resets the inline
                  // background so a fenced block is not double-shaded.
                  '[&_code]:bg-ink-800 [&_code]:text-ink-100 [&_code]:rounded [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.85em]',
                  '[&_pre]:bg-ink-950 [&_pre]:border-ink-800 [&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:border [&_pre]:p-3',
                  '[&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-xs',
                  // Tables, which are the point.
                  '[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:text-xs',
                  '[&_th]:border-ink-800 [&_th]:text-ink-300 [&_th]:border [&_th]:px-2 [&_th]:py-1.5 [&_th]:text-left [&_th]:font-medium',
                  // Tabular figures in cells, so columns of measurements align.
                  '[&_td]:border-ink-800/60 [&_td]:border [&_td]:px-2 [&_td]:py-1.5 [&_td]:tabular-nums',
                  '[&_hr]:border-ink-800 [&_hr]:my-6',
                )}
                // Safe here, and only here: build-time markdown from this repo,
                // with no runtime path for a visitor to inject into it.
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </CardBody>
          </Card>
        </div>
      )}
    </div>
  );
}
