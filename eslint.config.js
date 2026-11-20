import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'apps/api/drizzle/**',
      'apps/web/src/routeTree.gen.ts',
      'infra/**/.terraform/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // CONVENTIONS.md: one canonical log line per request, emitted by pino.
      // Nothing else writes to stdout from the server.
      'no-console': 'error',

      // Money is bigint. An implicit Number() coercion on an amount is the bug
      // this repo is about, so the compiler is not allowed to be relaxed here.
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',

      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/require-await': 'error',

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // Fastify's plugin contract (`FastifyPluginAsync`, and `fastify-plugin`'s
  // non-callback form) requires the function to be `async`, whether or not it
  // awaits anything. The registration itself is awaited by the caller, so
  // require-await here flags the framework's shape, not a mistake.
  {
    files: [
      'apps/api/src/plugins/**/*.ts',
      'apps/api/src/routes/**/*.ts',
      // Fastify plugins are not confined to one directory — the raw-body parser
      // lives next to the webhook code it exists for.
      'apps/api/src/webhooks/**/*.ts',
    ],
    rules: { '@typescript-eslint/require-await': 'off' },
  },

  // Scripts, load harness and config files are allowed to print: they are CLIs,
  // not request handlers.
  {
    files: [
      'scripts/**/*.{js,mjs,ts}',
      'load/**/*.js',
      '**/*.config.{js,ts,mjs}',
      // The alert sink's entire purpose is to print what it is sent.
      'observability/*.mjs',
    ],
    rules: { 'no-console': 'off' },
  },

  {
    files: ['**/*.js', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
  },

  // k6 scripts run in goja, not Node and not a browser. The globals it provides
  // are a short, specific list — spelled out rather than borrowed from
  // globals.node, so a script cannot reference `process` or `Buffer` and fail
  // only at run time.
  {
    files: ['load/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.es2024,
        console: 'readonly',
        __ENV: 'readonly',
        __VU: 'readonly',
        __ITER: 'readonly',
      },
    },
  },

  {
    files: [
      'apps/api/**/*.ts',
      'packages/**/*.ts',
      'scripts/**/*.{js,mjs,ts}',
      // Runs under plain Node in a container, with no bundler and no deps.
      'observability/*.mjs',
    ],
    languageOptions: { globals: { ...globals.node } },
  },

  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
);
