import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite-plus';
import { voidPlugin } from 'void';
import { voidReact } from '@void/react/plugin';
import { voidCelld } from './celld/vite';
import { lazyPlugins } from 'vite-plus';

export default defineConfig(({ mode }) => {
  const testing = mode === 'test' || process.env.VITEST === 'true';

  return {
    fmt: {
      singleQuote: true,
      semi: true,
      // sops writes these; reformatting would desync them from sops' own output.
      ignorePatterns: ['**/*.sops.yaml'],
    },
    lint: {
      jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
      rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
      options: { typeAware: true, typeCheck: true },
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
    plugins: lazyPlugins(() =>
      testing ? [] : [tailwindcss(), voidPlugin(), voidReact(), voidCelld()],
    ),
  };
});
