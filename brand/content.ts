/**
 * brand/content.ts — the single source of truth for nominee's positioning copy.
 *
 * Every *narrative* surface should derive its hero/tagline/when-not/layer copy
 * from here so a positioning change is one edit, not a dozen:
 *   - Visual assets (README banner, OG image, demo video) IMPORT this directly —
 *     see brand/compositions/*.tsx (rendered with Remotion).
 *   - Static surfaces that can't import TS (README.md, site/*.html, llms.txt)
 *     are kept in sync by hand against these strings; brand/README.md lists them
 *     as the "surface registry".
 *
 * If you change a string here, run `node brand/check-surfaces.mjs` (if present)
 * or walk brand/README.md's registry.
 */

export const brand = {
  name: 'nominee',
  version: '2.0.2',

  /** Full hero one-liner (README, docs, OG image). */
  taglineFull:
    "Fresh tokens, human approval, and an audit trail for agents that act on your users' behalf.",
  /** Compressed hero for the big display headline on the landing page. */
  taglineShort: 'Fresh tokens, approval & audit.',
  taglineShortLine2: 'For agents that act for your users.',

  /** Scope qualifier — names the tail nominee is for. */
  subhead:
    'Framework-neutral, no SaaS — the Passport.js of agent auth, for the multi-framework, no-lock-in, standalone tail.',

  /** The demonstrable insight that leads every surface. */
  insight:
    'Naive OAuth refresh breaks under rotation and concurrency: fire 8 concurrent tool calls and 7/8 fail with invalid_grant. nominee gets 8/8 with the same agent code.',
  insightShort: 'Naive concurrent + rotating OAuth refresh fails 7/8. nominee gets 8/8.',

  /** The layer diagram: framework | nominee | vault. */
  layers: [
    {
      tag: 'your agent / framework',
      title: 'asks for a token at call time',
      eg: 'Vercel AI SDK · Eve · Cloudflare Agents · standalone',
    },
    {
      tag: 'nominee',
      title: 'freshness · approval · audit · delegation',
      eg: 'single-flight refresh · rotation persistence · human-in-the-loop',
    },
    {
      tag: 'your vault / store',
      title: 'where the refresh token actually lives',
      eg: 'env · DB · OAuth2 · Auth0 Token Vault · Supabase · Nango',
    },
  ],

  /** "When you don't need nominee" — present on every surface. */
  whenNot: [
    "You're on Eve, or a framework that already brokers fresh third-party access.",
    'You use the Vercel AI SDK with Vercel Connect for connectors.',
    'One provider, a long-lived non-rotating token, no pause, no concurrency.',
    'You want one fully-managed vendor — use Auth0 Token Vault or Nango directly.',
  ],

  urls: {
    site: 'https://nominee.dev',
    docs: 'https://nominee.dev/docs/',
    repo: 'https://github.com/bharath31/nominee',
    npm: 'https://www.npmjs.com/package/nominee',
    proofExample:
      'https://github.com/bharath31/nominee/tree/main/examples/token-refresh-correctness',
  },

  colors: {
    paper: '#faf9f5',
    ink: '#0b1020',
    inkSoft: '#3a4154',
    muted: '#71798c',
    seal: '#8c2f2a',
    sealBright: '#a8413a',
    line: '#e7e3d8',
    ok: '#1f6b4a',
  },
} as const

export type Brand = typeof brand
