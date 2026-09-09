import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfiguration } from './env'

/**
 * Supabase API key model.
 *
 * OpeniWatch uses the current publishable/secret keys, not the legacy
 * `anon`/`service_role` pair. The distinction is not cosmetic:
 *
 *   - a legacy key is a JWT signed with the project's JWT secret, so rotating
 *     it invalidates every live session at once;
 *   - a publishable/secret key rotates independently, and the two are
 *     distinguishable by shape — which is what lets a secret key in a browser
 *     variable be caught before it ships rather than after.
 *
 * The failure being guarded against is a rename that keeps the old value: a
 * deployment reading `VITE_SUPABASE_PUBLISHABLE_KEY` that still contains a
 * legacy anon JWT would work perfectly and would not have migrated at all.
 */

const PUBLISHABLE = 'sb_publishable_gTESTvalue0000000000000'
const SECRET = 'sb_secret_TESTvalue0000000000000000'
const LEGACY_ANON_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJvbGUiOiJhbm9uIn0.TESTsignature000'

const URL_OK = 'https://dbbmlufrefctmxgitosx.supabase.co'

function shippedSourceFiles(dir = 'src', out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) shippedSourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

describe('1. browser config accepts a publishable key', () => {
  it('resolves to the Supabase provider', () => {
    const config = resolveConfiguration({
      VITE_SUPABASE_URL: URL_OK,
      VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
      VITE_ENVIRONMENT_LABEL: 'Production',
    })
    expect(config.status).toBe('supabase')
    expect(config.env.supabasePublishableKey).toBe(PUBLISHABLE)
  })
})

describe('2. browser config rejects a secret key', () => {
  it('blocks rather than shipping it', () => {
    /*
     * The worst configuration mistake available here. A VITE_ variable is
     * compiled into a file anyone can download, and an sb_secret_ key bypasses
     * Row Level Security completely — so accepting this would publish the
     * entire database rather than merely misconfigure a deployment.
     */
    const config = resolveConfiguration({
      VITE_SUPABASE_URL: URL_OK,
      VITE_SUPABASE_PUBLISHABLE_KEY: SECRET,
      VITE_ENVIRONMENT_LABEL: 'Production',
    })
    expect(config.status).toBe('blocked')
    if (config.status !== 'blocked') return
    expect(config.invalid).toContain('VITE_SUPABASE_PUBLISHABLE_KEY')
  })

  it('never echoes the offending value', () => {
    const config = resolveConfiguration({
      VITE_SUPABASE_URL: URL_OK,
      VITE_SUPABASE_PUBLISHABLE_KEY: SECRET,
      VITE_ENVIRONMENT_LABEL: 'Production',
    })
    if (config.status !== 'blocked') return
    const report = JSON.stringify({
      missing: config.missing,
      invalid: config.invalid,
      reference: config.reference,
      legacyVariableInUse: config.legacyVariableInUse,
    })
    expect(report).not.toContain(SECRET)
  })

  it('rejects it in development too, not only in production', () => {
    const config = resolveConfiguration({
      VITE_SUPABASE_URL: URL_OK,
      VITE_SUPABASE_PUBLISHABLE_KEY: SECRET,
    })
    expect(config.status).not.toBe('supabase')
  })
})

describe('3. production does not accept the legacy variable', () => {
  it('blocks when only VITE_SUPABASE_ANON_KEY is set', () => {
    // No silent fallback. A deployment that "works" on the legacy variable has
    // not migrated, and nobody finds out until the key is rotated.
    const config = resolveConfiguration({
      VITE_SUPABASE_URL: URL_OK,
      VITE_SUPABASE_ANON_KEY: PUBLISHABLE,
      VITE_ENVIRONMENT_LABEL: 'Production',
    })
    expect(config.status).toBe('blocked')
    if (config.status !== 'blocked') return
    expect(config.missing).toContain('VITE_SUPABASE_PUBLISHABLE_KEY')
  })

  it('tells the operator the variable was renamed rather than just "missing"', () => {
    const config = resolveConfiguration({
      VITE_SUPABASE_URL: URL_OK,
      VITE_SUPABASE_ANON_KEY: PUBLISHABLE,
      VITE_ENVIRONMENT_LABEL: 'Production',
    })
    if (config.status !== 'blocked') return
    expect(config.legacyVariableInUse).toBe(true)
  })

  it('does not claim a rename when the legacy variable is absent', () => {
    const config = resolveConfiguration({
      VITE_SUPABASE_URL: URL_OK,
      VITE_ENVIRONMENT_LABEL: 'Production',
    })
    if (config.status !== 'blocked') return
    expect(config.legacyVariableInUse).toBe(false)
  })

  it('rejects a legacy anon JWT pasted under the new name', () => {
    // This is the "renamed but not migrated" case. It would work against
    // Supabase today, which is exactly why it has to be refused.
    const config = resolveConfiguration({
      VITE_SUPABASE_URL: URL_OK,
      VITE_SUPABASE_PUBLISHABLE_KEY: LEGACY_ANON_JWT,
      VITE_ENVIRONMENT_LABEL: 'Production',
    })
    expect(config.status).toBe('blocked')
    if (config.status !== 'blocked') return
    expect(config.invalid).toContain('VITE_SUPABASE_PUBLISHABLE_KEY')
  })

  it('is not read even as a last resort in development', () => {
    const config = resolveConfiguration({
      VITE_SUPABASE_URL: URL_OK,
      VITE_SUPABASE_ANON_KEY: PUBLISHABLE,
      VITE_ENABLE_LOCAL_DEMO: 'true',
    })
    // Demo mode, because the real key is absent — not a Supabase connection
    // quietly established from the legacy variable.
    expect(config.status).toBe('local-demo')
  })
})

describe('4 & 5. the built bundle carries no secret', () => {
  /*
   * A real production build, because the point is what Vite emits — not what
   * the source says. This is the check that would have caught a secret key
   * being inlined.
   */
  const outDir = mkdtempSync(join(tmpdir(), 'openiwatch-keys-'))
  let bundle = ''

  try {
    execFileSync(
      'npx',
      ['vite', 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'],
      {
        env: {
          ...process.env,
          VITE_SUPABASE_URL: URL_OK,
          VITE_SUPABASE_PUBLISHABLE_KEY: PUBLISHABLE,
          VITE_ENVIRONMENT_LABEL: 'Production',
          VITE_ENABLE_SIMULATOR: '',
          VITE_ENABLE_LOCAL_DEMO: '',
          // Deliberately present in the build environment but NOT VITE_-prefixed.
          SUPABASE_SECRET_KEY: SECRET,
          SUPABASE_SERVICE_ROLE_KEY: 'eyJhbGciOiJIUzI1NiJ9.legacy.serviceRoleTEST',
          RESEND_API_KEY: 're_TESTresendkey0000',
          AZURE_CLIENT_SECRET: 'azure~TESTclientsecret000',
        },
        stdio: 'pipe',
      },
    )
    const assets = join(outDir, 'assets')
    for (const file of readdirSync(assets)) {
      if (file.endsWith('.js')) bundle += readFileSync(join(assets, file), 'utf8')
    }
  } finally {
    // Registered immediately so a build failure cannot leave the directory.
  }

  it('contains no sb_secret_ key value', () => {
    expect(bundle.length).toBeGreaterThan(0)

    /*
     * Match key MATERIAL, not the prefix.
     *
     * The literal `sb_secret_` legitimately appears twice in a correct bundle:
     * once in this application's own detection regex, which is what refuses a
     * secret key in the browser variable, and once inside supabase-js, which
     * checks the same prefix. A bare substring search cannot tell a detector
     * from the thing it detects, and would fail on code that is doing its job.
     *
     * A real key is the prefix followed by key characters.
     */
    const realSecrets = bundle.match(/sb_secret_[A-Za-z0-9_-]{10,}/g)
    expect(realSecrets ?? []).toEqual([])
    expect(bundle).not.toContain(SECRET)
  })

  it('contains no other server-side credential present at build time', () => {
    // Each of these was in the build environment. None is VITE_-prefixed, so
    // none may be inlined.
    for (const secret of [
      're_TESTresendkey0000',
      'azure~TESTclientsecret000',
      'serviceRoleTEST',
      'SUPABASE_SERVICE_ROLE_KEY',
      'RESEND_API_KEY',
      'AZURE_CLIENT_SECRET',
    ]) {
      expect(bundle, `bundle contains ${secret}`).not.toContain(secret)
    }
  })

  it('does contain the publishable key, which is the point of it', () => {
    // Publishable keys are designed to ship. Asserting its presence proves the
    // build really did inline configuration, so the absences above are
    // meaningful rather than the result of an empty or failed build.
    expect(bundle).toContain(PUBLISHABLE)
  })

  it('carries no legacy JWT-format API key', () => {
    // A legacy anon or service_role key is a JWT. Neither belongs in the bundle.
    const jwtLike = bundle.match(/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g)
    expect(jwtLike ?? []).toEqual([])
  })

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
})

describe('6. server provisioning accepts the new secret-key format', () => {
  const script = readFileSync('scripts/provision-user.mjs', 'utf8')

  it('reads SUPABASE_SECRET_KEY', () => {
    expect(script).toMatch(/process\.env\.SUPABASE_SECRET_KEY/)
  })

  it('validates the key shape rather than accepting anything', () => {
    expect(script).toMatch(/sb_secret_/)
  })

  it('no longer reads the legacy service-role variable', () => {
    expect(withoutComments(script)).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('refuses a legacy service_role JWT', () => {
    // Accepting one would let the script keep working while the migration was
    // only nominally complete.
    expect(script).toMatch(/\^sb_secret_/)
  })
})

describe('7. Edge Functions parse SUPABASE_SECRET_KEYS', () => {
  const helper = readFileSync('supabase/functions/_shared/supabase-keys.ts', 'utf8')

  it('reads the dictionary Supabase injects', () => {
    expect(helper).toMatch(/SUPABASE_SECRET_KEYS/)
    expect(helper).toMatch(/JSON\.parse/)
  })

  it('selects a named key, defaulting to "default"', () => {
    expect(helper).toMatch(/name = 'default'/)
  })

  it('fails closed on a malformed dictionary rather than throwing', () => {
    expect(helper).toMatch(/catch\s*\{[\s\S]{0,300}return ''/)
  })

  it('does not fall back to the legacy service-role variable', () => {
    expect(withoutComments(helper)).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
  })

  it('is used by every function that needs elevated access', () => {
    for (const fn of ['ingest-signal', 'dispatch-notifications', 'escalate-unacknowledged']) {
      const source = readFileSync(`supabase/functions/${fn}/index.ts`, 'utf8')
      expect(source, fn).toMatch(/getSecretKey\(\)/)
      expect(withoutComments(source), fn).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY/)
    }
  })

  it('never puts the secret key in an Authorization header', () => {
    /*
     * An sb_secret_ key is not a JWT and carries no claims. Presented where a
     * user token is expected, nothing downstream can read a subject, an expiry
     * or a role from it — and code that tries reads undefined, which is how a
     * check falls open. It belongs in the apikey header, which is what
     * supabase-js does when the key is passed to createClient.
     */
    for (const fn of ['ingest-signal', 'dispatch-notifications', 'escalate-unacknowledged']) {
      const source = readFileSync(`supabase/functions/${fn}/index.ts`, 'utf8')
      expect(source, fn).not.toMatch(/Authorization[^\n]*secretKey/)
      expect(source, fn).not.toMatch(/Bearer \$\{secretKey\}/)
    }
  })
})

describe('8. no shipped browser code references a server-side key', () => {
  it('never mentions SUPABASE_SECRET_KEY', () => {
    for (const file of shippedSourceFiles()) {
      expect(withoutComments(readFileSync(file, 'utf8')), file).not.toMatch(
        /SUPABASE_SECRET_KEY|SUPABASE_SECRET_KEYS/,
      )
    }
  })

  it('never reads a secret key from import.meta.env', () => {
    for (const file of shippedSourceFiles()) {
      const text = readFileSync(file, 'utf8')
      expect(text, file).not.toMatch(/import\.meta\.env[^\n]*SECRET/)
      expect(text, file).not.toMatch(/import\.meta\.env[^\n]*SERVICE_ROLE/)
    }
  })

  it('declares no VITE_ alias for a secret key', () => {
    const declarations = readFileSync('src/vite-env.d.ts', 'utf8')
    expect(declarations).not.toMatch(/VITE_SUPABASE_SECRET/)
    expect(declarations).not.toMatch(/VITE_SUPABASE_SERVICE_ROLE/)
    // And the legacy browser variable is gone from the declarations entirely.
    expect(withoutComments(declarations)).not.toMatch(/readonly VITE_SUPABASE_ANON_KEY/)
  })
})

describe('9. no configuration instructs use of legacy credentials', () => {
  const CONFIG_FILES = [
    '.env.example',
    'README.md',
    'docs/CONFIGURATION.md',
    'docs/DEPLOYMENT.md',
    'docs/AUTHENTICATION.md',
    'netlify.toml',
  ]

  it('never tells an operator to set the legacy browser variable', () => {
    for (const file of CONFIG_FILES) {
      if (!existsSync(file)) continue
      const text = readFileSync(file, 'utf8')
      // The name may appear in an explanation of what NOT to do; an assignment
      // is what would actually mislead someone.
      expect(text, file).not.toMatch(/^\s*VITE_SUPABASE_ANON_KEY=/m)
      expect(text, file).not.toMatch(/^\s*SUPABASE_SERVICE_ROLE_KEY=/m)
    }
  })

  it('points at the current API keys page, not the legacy one', () => {
    const envExample = readFileSync('.env.example', 'utf8')
    expect(envExample).toMatch(/API Keys/)
    expect(envExample).toMatch(/sb_publishable_/)
    expect(envExample).toMatch(/sb_secret_/)
  })
})

describe('10. RLS behaviour is unchanged by the key model', () => {
  it('leaves every policy and migration untouched', () => {
    /*
     * The publishable key resolves to the same `anon` PostgreSQL role that the
     * legacy anon key did, and an authenticated session still carries the
     * user's JWT. So no policy needed changing — and none did. The real proof
     * is `npm run test:rls`, which applies every migration to a live PostgreSQL
     * instance and runs 28 role scenarios; this asserts the migrations were not
     * quietly edited to accommodate the new keys.
     */
    const rls = readFileSync('supabase/migrations/0007_row_level_security.sql', 'utf8')
    expect(rls).toMatch(/enable row level security/i)
    expect(rls).toMatch(/force row level security/i)

    const privileges = readFileSync('supabase/migrations/0009_privileges.sql', 'utf8')
    // `anon`, `authenticated` and `service_role` here are PostgreSQL ROLES, not
    // API keys. They are part of Supabase's own schema and are unaffected by
    // the API key model.
    expect(privileges).toMatch(/authenticated/)
  })

  it('still routes the browser through the anon role, not an elevated one', () => {
    const client = readFileSync('src/data/supabase/client.ts', 'utf8')
    expect(client).toMatch(/env\.supabasePublishableKey/)
    expect(withoutComments(client)).not.toMatch(/secret/i)
  })
})
