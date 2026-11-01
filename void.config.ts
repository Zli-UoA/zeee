import { defineConfig } from 'void/config';

export default defineConfig({
  target: 'cloudflare',
  head: {
    title: 'Zeee',
    titleTemplate: '%s | Zeee',
    htmlAttrs: { lang: 'ja' },
    meta: [
      { charset: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { name: 'color-scheme', content: 'light' },
    ],
    link: [{ rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
  },
  cloudflare: {
    name: 'zeee',
    vars: {
      AUTHZ_ISSUER: 'https://account.zli.works/api/auth',
      AUTHZ_CLIENT_ID: 'ocfGoISXBgnRMqogOLEdYsZUXusTBczV',
      PUBLIC_ORIGIN: 'https://zeee.zli.works',
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: 'zeee',
        migrations_dir: 'migrations',
        database_id: '7c9e6a52-5f2e-4d7a-9a1b-8f3c2d1e4b60',
      },
    ],
  },
  worker: {
    compatibility_date: '2026-02-24',
    compatibility_flags: ['nodejs_compat'],
  },
});
