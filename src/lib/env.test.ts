import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isSimulatorAvailable,
  normalizeEnvironment,
  resolveConfiguration,
  type Configuration,
} from './env'

/**
 * Configuration rules.
 *
 * These exist because the deployed application once showed "Local demo mode.
 * No Supabase credentials are configured." on a real staging site. That is the
 * worst available failure: it looks like a working security operations tool
 * while being backed by data that exists only in one browser tab.
 */

const SUPABASE = {
  VITE_SUPABASE_URL: 'https://example-ref.supabase.co',
  VITE_SUPABASE_ANON_KEY: 'anon-key-for-tests',
}

describe('normalizeEnvironment', () => {
  it('recognises staging and production regardless of case and spacing', () => {
    for (const value of ['Staging', 'staging', ' STAGING ', 'stage']) {
      expect(normalizeEnvironment(value)).toBe('staging')
    }
    for (const value of ['Production', 'production', ' PROD ', 'prod']) {
      expect(normalizeEnvironment(value)).toBe('production')
    }
  })

  it('treats an empty or unrecognised label as development', () => {
    expect(normalizeEnvironment('')).toBe('development')
    expect(normalizeEnvironment('   ')).toBe('development')
    expect(normalizeEnvironment('QA sandbox')).toBe('development')
  })
})

describe('1. local demo explicitly enabled', () => {
  it('runs the demo provider when the flag is set and no environment is claimed', () => {
    const config = resolveConfiguration({ VITE_ENABLE_LOCAL_DEMO: 'true' })
    expect(config.status).toBe('local-demo')
  })

  it('requires the word "true" and nothing looser', () => {
    // Truthy-looking values that are NOT the word true must not enable demo.
    // Accepting "1" or "yes" here would mean a stray value in a hosting
    // dashboard could switch a deployment onto fake data.
    for (const value of ['1', 'yes', 'on', 'enabled', '']) {
      const config = resolveConfiguration({ VITE_ENABLE_LOCAL_DEMO: value })
      expect(config.status, `value ${JSON.stringify(value)} must not enable demo`).toBe('blocked')
    }
  })

  it('accepts the word regardless of case or surrounding whitespace', () => {
    // An administrator typing "TRUE" into a dashboard field means it.
    for (const value of ['true', 'TRUE', ' True ']) {
      const config = resolveConfiguration({ VITE_ENABLE_LOCAL_DEMO: value })
      expect(config.status, `value ${JSON.stringify(value)} should enable demo`).toBe('local-demo')
    }
  })
})

describe('2. local demo not explicitly enabled', () => {
  it('blocks rather than silently starting the demo provider', () => {
    const config = resolveConfiguration({})
    expect(config.status).toBe('blocked')
    if (config.status !== 'blocked') return
    expect(config.missing).toEqual(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'])
  })

  it('is the regression guard: an empty environment is not an invitation to fake data', () => {
    // The previous implementation returned 'local-demo' here. That single line
    // is what put demo data on a deployed site.
    expect(resolveConfiguration({}).status).not.toBe('local-demo')
  })
})

describe('3. staging with complete Supabase configuration', () => {
  it('selects the Supabase provider', () => {
    const config = resolveConfiguration({ ...SUPABASE, VITE_ENVIRONMENT_LABEL: 'Staging' })
    expect(config.status).toBe('supabase')
    expect(config.env.deployment).toBe('staging')
  })

  it('ignores VITE_ENABLE_LOCAL_DEMO when Supabase is reachable', () => {
    const config = resolveConfiguration({
      ...SUPABASE,
      VITE_ENVIRONMENT_LABEL: 'Staging',
      VITE_ENABLE_LOCAL_DEMO: 'true',
    })
    expect(config.status).toBe('supabase')
  })
})

describe('4. staging with a missing URL', () => {
  it('blocks and names only the missing variable', () => {
    const config = resolveConfiguration({
      VITE_SUPABASE_ANON_KEY: SUPABASE.VITE_SUPABASE_ANON_KEY,
      VITE_ENVIRONMENT_LABEL: 'Staging',
    })
    expect(config.status).toBe('blocked')
    if (config.status !== 'blocked') return
    expect(config.missing).toEqual(['VITE_SUPABASE_URL'])
    expect(config.reference).toBe('OW-CFG-STG-U')
  })

  it('blocks even when local demo is explicitly requested', () => {
    const config = resolveConfiguration({
      VITE_ENVIRONMENT_LABEL: 'Staging',
      VITE_ENABLE_LOCAL_DEMO: 'true',
    })
    expect(config.status).toBe('blocked')
  })

  it('treats a present-but-unusable URL as a configuration failure', () => {
    const config = resolveConfiguration({
      ...SUPABASE,
      VITE_SUPABASE_URL: 'not-a-url',
      VITE_ENVIRONMENT_LABEL: 'Staging',
    })
    expect(config.status).toBe('blocked')
    if (config.status !== 'blocked') return
    expect(config.invalid).toEqual(['VITE_SUPABASE_URL'])
  })
})

describe('5. staging with a missing key', () => {
  it('blocks and names only the missing variable', () => {
    const config = resolveConfiguration({
      VITE_SUPABASE_URL: SUPABASE.VITE_SUPABASE_URL,
      VITE_ENVIRONMENT_LABEL: 'Staging',
    })
    expect(config.status).toBe('blocked')
    if (config.status !== 'blocked') return
    expect(config.missing).toEqual(['VITE_SUPABASE_ANON_KEY'])
    expect(config.reference).toBe('OW-CFG-STG-K')
  })
})

describe('6. production with missing configuration', () => {
  it('blocks', () => {
    const config = resolveConfiguration({ VITE_ENVIRONMENT_LABEL: 'Production' })
    expect(config.status).toBe('blocked')
    if (config.status !== 'blocked') return
    expect(config.missing).toEqual(['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'])
    expect(config.reference).toBe('OW-CFG-PRD-UK')
  })

  it('blocks even with the demo flag set', () => {
    const config = resolveConfiguration({
      VITE_ENVIRONMENT_LABEL: 'Production',
      VITE_ENABLE_LOCAL_DEMO: 'true',
    })
    expect(config.status).toBe('blocked')
  })

  it('never exposes a value in the blocked payload', () => {
    const config = resolveConfiguration({
      VITE_SUPABASE_URL: 'not-a-url-but-a-secret-looking-value',
      VITE_ENVIRONMENT_LABEL: 'Production',
    })
    const serialized = JSON.stringify(config, (key, value) =>
      // The env block legitimately carries the raw values for the app's own
      // use; the blocked *report* is what must be safe to display.
      key === 'env' ? undefined : (value as unknown),
    )
    expect(serialized).not.toContain('secret-looking-value')
  })
})

describe('7. no server-side secret variable is read by browser code', () => {
  const FORBIDDEN = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'ONESIGNAL_REST_API_KEY',
    'OPENIWATCH_INGEST_SECRET',
    'SUPABASE_DB_PASSWORD',
    'SUPABASE_ACCESS_TOKEN',
    'NETLIFY_AUTH_TOKEN',
  ]

  function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) sourceFiles(full, out)
      else if (/\.tsx?$/.test(entry.name)) out.push(full)
    }
    return out
  }

  it('never reads a forbidden name from import.meta.env', () => {
    const offenders: string[] = []
    for (const file of sourceFiles('src')) {
      const text = readFileSync(file, 'utf8')
      for (const name of FORBIDDEN) {
        // A forbidden name may appear in prose — an operator-facing message
        // telling an administrator which server-side variable to set is fine.
        // Reading one through import.meta.env is not.
        const read = new RegExp(`import\\.meta\\.env\\s*(\\.\\s*${name}|\\[\\s*['"\`]${name})`)
        if (read.test(text)) offenders.push(`${file}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('never declares a VITE_ alias for a forbidden name', () => {
    const declarations = readFileSync('src/vite-env.d.ts', 'utf8')
    for (const name of FORBIDDEN) {
      expect(declarations).not.toMatch(new RegExp(`readonly\\s+VITE_${name}`))
    }
  })

  it('resolves configuration only from VITE_-prefixed names', () => {
    // Every forbidden name supplied at once must change nothing.
    const hostile: Record<string, string> = { VITE_ENABLE_LOCAL_DEMO: 'true' }
    for (const name of FORBIDDEN) hostile[name] = 'value-that-must-be-ignored'
    const config = resolveConfiguration(hostile)
    expect(config.status).toBe('local-demo')
    expect(JSON.stringify(config)).not.toContain('value-that-must-be-ignored')
  })
})

describe('simulator availability', () => {
  const withEnv = (raw: Record<string, string>): Configuration => resolveConfiguration(raw)

  it('is off unless explicitly enabled', () => {
    expect(isSimulatorAvailable(withEnv({ VITE_ENABLE_LOCAL_DEMO: 'true' }))).toBe(false)
  })

  it('is on in development when the flag is set', () => {
    expect(
      isSimulatorAvailable(
        withEnv({ VITE_ENABLE_LOCAL_DEMO: 'true', VITE_ENABLE_SIMULATOR: 'true' }),
      ),
    ).toBe(true)
  })

  it('is on in staging when the flag is set', () => {
    expect(
      isSimulatorAvailable(
        withEnv({ ...SUPABASE, VITE_ENVIRONMENT_LABEL: 'Staging', VITE_ENABLE_SIMULATOR: 'true' }),
      ),
    ).toBe(true)
  })

  it('is off in production even when the flag is set', () => {
    expect(
      isSimulatorAvailable(
        withEnv({
          ...SUPABASE,
          VITE_ENVIRONMENT_LABEL: 'Production',
          VITE_ENABLE_SIMULATOR: 'true',
        }),
      ),
    ).toBe(false)
  })

  it('is not granted by demo mode alone', () => {
    const config = withEnv({ VITE_ENABLE_LOCAL_DEMO: 'true' })
    expect(config.status).toBe('local-demo')
    expect(isSimulatorAvailable(config)).toBe(false)
  })
})
