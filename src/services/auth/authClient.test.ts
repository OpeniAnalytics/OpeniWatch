import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAGIC_LINK_GENERIC_MESSAGE,
  MAGIC_LINK_PATH,
  MICROSOFT_PROVIDER,
  MICROSOFT_SCOPES,
  OAUTH_CALLBACK_PATH,
  buildRedirectUrl,
  cleanAuthParamsFromUrl,
  completeMagicLink,
  completeOAuthCallback,
  requestMagicLink,
  resetConsumedCredentials,
  safeNext,
  startMicrosoftSignIn,
  type SupabaseAuthLike,
} from './authClient'

/**
 * Authentication flows.
 *
 * The rules here fail quietly when they fail: a code exchanged twice reports a
 * failure for a sign-in that worked, a magic-link response that varies turns
 * the form into a staff directory, and an unchecked `next` turns a sign-in
 * route into an open redirect on a real domain.
 */


/**
 * Source files that are actually shipped to the browser.
 *
 * Test files live under src/ but are never imported by main.tsx and never
 * reach a bundle, so scanning them would only find this file's own assertions
 * quoting the very strings it forbids.
 */
function shippedSourceFiles(dir = 'src', out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) shippedSourceFiles(full, out)
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * Strips comments so a scan sees code and rendered copy, not prose.
 *
 * These files explain at length what they deliberately do NOT do — "there is no
 * password field", "no invitation is sent" — and a naive substring search reads
 * those explanations as violations.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const ORIGIN = 'https://openiwatch.netlify.app'

interface Harness {
  auth: SupabaseAuthLike
  calls: string[]
  oauth: ReturnType<typeof vi.fn>
  otp: ReturnType<typeof vi.fn>
  exchange: ReturnType<typeof vi.fn>
  verify: ReturnType<typeof vi.fn>
}

function harness(
  overrides: {
    oauthError?: { message: string } | null
    otpError?: { message: string } | null
    exchangeError?: { message: string } | null
    verifyError?: { message: string } | null
    session?: unknown
  } = {},
): Harness {
  const calls: string[] = []
  const session = overrides.session === undefined ? { access_token: 'token' } : overrides.session

  const oauth = vi.fn(async () => {
    calls.push('signInWithOAuth')
    return { error: overrides.oauthError ?? null }
  })
  const otp = vi.fn(async () => {
    calls.push('signInWithOtp')
    return { error: overrides.otpError ?? null }
  })
  const exchange = vi.fn(async (code: string) => {
    calls.push(`exchangeCodeForSession:${code}`)
    return {
      data: { session: overrides.exchangeError ? null : session },
      error: overrides.exchangeError ?? null,
    }
  })
  const verify = vi.fn(async (params: { token_hash: string; type: string }) => {
    calls.push(`verifyOtp:${params.token_hash}:${params.type}`)
    return {
      data: { session: overrides.verifyError ? null : session },
      error: overrides.verifyError ?? null,
    }
  })

  return {
    calls,
    oauth,
    otp,
    exchange,
    verify,
    auth: {
      signInWithOAuth: oauth,
      signInWithOtp: otp,
      exchangeCodeForSession: exchange,
      verifyOtp: verify,
    } as unknown as SupabaseAuthLike,
  }
}

beforeEach(() => resetConsumedCredentials())

describe('Microsoft sign-in', () => {
  it("invokes the provider Supabase calls 'azure'", async () => {
    const h = harness()
    await startMicrosoftSignIn(h.auth, ORIGIN)

    expect(MICROSOFT_PROVIDER).toBe('azure')
    const params = h.oauth.mock.calls[0]![0] as { provider: string }
    expect(params.provider).toBe('azure')
  })

  it('requests the email scope and nothing wider', async () => {
    const h = harness()
    await startMicrosoftSignIn(h.auth, ORIGIN)

    const params = h.oauth.mock.calls[0]![0] as { options: { scopes: string } }
    expect(params.options.scopes).toBe('email')
    expect(MICROSOFT_SCOPES).toBe('email')
    // Directory or profile scopes would mean holding data the product has no
    // use for and cannot justify to a tenant administrator.
    expect(params.options.scopes).not.toMatch(/profile|openid|User\.Read|Directory/i)
  })

  it('returns to the callback route on this origin', async () => {
    const h = harness()
    await startMicrosoftSignIn(h.auth, ORIGIN)

    const params = h.oauth.mock.calls[0]![0] as { options: { redirectTo: string } }
    expect(params.options.redirectTo).toBe(`${ORIGIN}${OAUTH_CALLBACK_PATH}`)
    expect(params.options.redirectTo).toBe('https://openiwatch.netlify.app/auth/callback')
  })

  it('carries a safe post-login target and discards a hostile one', async () => {
    const safe = harness()
    await startMicrosoftSignIn(safe.auth, ORIGIN, '/alerts/abc-123')
    expect(
      (safe.oauth.mock.calls[0]![0] as { options: { redirectTo: string } }).options.redirectTo,
    ).toBe(`${ORIGIN}${OAUTH_CALLBACK_PATH}?next=%2Falerts%2Fabc-123`)

    const hostile = harness()
    await startMicrosoftSignIn(hostile.auth, ORIGIN, 'https://evil.example/steal')
    expect(
      (hostile.oauth.mock.calls[0]![0] as { options: { redirectTo: string } }).options.redirectTo,
    ).toBe(`${ORIGIN}${OAUTH_CALLBACK_PATH}`)
  })

  it('reports a provider failure without leaking detail', async () => {
    const h = harness({ oauthError: { message: 'azure provider is not enabled' } })
    const result = await startMicrosoftSignIn(h.auth, ORIGIN)

    expect(result.ok).toBe(false)
    if (result.ok) return
    // The dashboard misconfiguration goes to the Supabase log, not the screen.
    expect(result.message).not.toMatch(/azure provider is not enabled/)
  })
})

describe('magic link request', () => {
  it('asks Supabase for a one-time link to the confirm route', async () => {
    const h = harness()
    await requestMagicLink(h.auth, ORIGIN, 'operator@company.com')

    const params = h.otp.mock.calls[0]![0] as {
      email: string
      options: { shouldCreateUser: boolean; emailRedirectTo: string }
    }
    expect(params.email).toBe('operator@company.com')
    expect(params.options.emailRedirectTo).toBe(`${ORIGIN}${MAGIC_LINK_PATH}`)
    expect(params.options.emailRedirectTo).toBe('https://openiwatch.netlify.app/auth/confirm')
  })

  it('never creates an account, which is what closes self-registration', async () => {
    const h = harness()
    await requestMagicLink(h.auth, ORIGIN, 'stranger@example.com')

    const params = h.otp.mock.calls[0]![0] as { options: { shouldCreateUser: boolean } }
    expect(params.options.shouldCreateUser).toBe(false)
  })

  it('answers identically for unknown, unauthorized and rate-limited addresses', async () => {
    const known = await requestMagicLink(harness().auth, ORIGIN, 'operator@company.com')
    const unknown = await requestMagicLink(
      harness({ otpError: { message: 'Signups not allowed for otp' } }).auth,
      ORIGIN,
      'stranger@example.com',
    )
    const limited = await requestMagicLink(
      harness({ otpError: { message: 'email rate limit exceeded' } }).auth,
      ORIGIN,
      'operator@company.com',
    )

    // One sentence, every time. Anything else is an account-enumeration oracle.
    for (const result of [known, unknown, limited]) {
      expect(result.ok).toBe(true)
      expect(result.message).toBe(MAGIC_LINK_GENERIC_MESSAGE)
    }
    expect(new Set([known.message, unknown.message, limited.message]).size).toBe(1)
  })

  it('rejects a malformed address without contacting Supabase', async () => {
    const h = harness()
    const result = await requestMagicLink(h.auth, ORIGIN, 'not-an-address')
    expect(result.ok).toBe(false)
    expect(h.otp).not.toHaveBeenCalled()
  })
})

describe('post-login redirect safety', () => {
  it('keeps an in-app path', () => {
    expect(safeNext('/alerts')).toBe('/alerts')
    expect(safeNext('/alerts/8f3c?tab=history')).toBe('/alerts/8f3c?tab=history')
  })

  it('refuses anything that could leave this origin', () => {
    for (const hostile of [
      'https://evil.example',
      'http://evil.example',
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'evil.example',
      '/redirect?to=https://evil.example/../..',
    ]) {
      const result = safeNext(hostile)
      expect(result === '/' || result.startsWith('/redirect'), `${hostile} -> ${result}`).toBe(true)
      expect(result).not.toContain('//evil.example')
    }
    expect(safeNext('//evil.example')).toBe('/')
    expect(safeNext('https://evil.example')).toBe('/')
  })

  it('refuses to bounce back into the auth routes', () => {
    expect(safeNext('/auth/callback')).toBe('/')
    expect(safeNext('/auth/confirm?token_hash=abc')).toBe('/')
  })

  it('omits the parameter entirely when there is nothing to carry', () => {
    expect(buildRedirectUrl(ORIGIN, OAUTH_CALLBACK_PATH, null)).toBe(
      `${ORIGIN}${OAUTH_CALLBACK_PATH}`,
    )
  })
})

describe('OAuth callback', () => {
  it('exchanges the code and reports where to go next', async () => {
    const h = harness()
    const result = await completeOAuthCallback(
      h.auth,
      `${ORIGIN}/auth/callback?code=abc123&next=%2Falerts`,
    )

    expect(result).toEqual({ status: 'success', next: '/alerts' })
    expect(h.exchange).toHaveBeenCalledTimes(1)
    expect(h.exchange).toHaveBeenCalledWith('abc123')
  })

  it('exchanges a given code exactly once, however many times it is handled', async () => {
    const h = harness()
    const href = `${ORIGIN}/auth/callback?code=single-use`

    const first = await completeOAuthCallback(h.auth, href)
    const second = await completeOAuthCallback(h.auth, href)
    const third = await completeOAuthCallback(h.auth, href)

    // React's double effect invocation, or a refresh, must not burn the code
    // and then report the resulting failure to someone who did sign in.
    expect(h.exchange).toHaveBeenCalledTimes(1)
    expect(first.status).toBe('success')
    expect(second.status).toBe('success')
    expect(third.status).toBe('success')
  })

  it('reports a provider refusal carried in the URL', async () => {
    const h = harness()
    const result = await completeOAuthCallback(
      h.auth,
      `${ORIGIN}/auth/callback?error=access_denied&error_description=The+user+cancelled`,
    )

    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toMatch(/cancelled or refused/i)
    // Nothing was exchanged: there was no code to exchange.
    expect(h.exchange).not.toHaveBeenCalled()
  })

  it('reports a failed exchange', async () => {
    const h = harness({ exchangeError: { message: 'invalid request: code not found' } })
    const result = await completeOAuthCallback(h.auth, `${ORIGIN}/auth/callback?code=stale`)

    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toMatch(/no longer valid/i)
  })

  it('refuses a hostile next even when the exchange succeeds', async () => {
    const h = harness()
    const result = await completeOAuthCallback(
      h.auth,
      `${ORIGIN}/auth/callback?code=ok&next=https%3A%2F%2Fevil.example`,
    )
    expect(result).toEqual({ status: 'success', next: '/' })
  })

  it('reports an incomplete callback rather than failing silently', async () => {
    const h = harness()
    const result = await completeOAuthCallback(h.auth, `${ORIGIN}/auth/callback`)
    expect(result.status).toBe('error')
    expect(h.exchange).not.toHaveBeenCalled()
  })
})

describe('magic link confirmation', () => {
  it('verifies a token hash', async () => {
    const h = harness()
    const result = await completeMagicLink(
      h.auth,
      `${ORIGIN}/auth/confirm?token_hash=hash-abc&type=magiclink`,
    )

    expect(result).toEqual({ status: 'success', next: '/' })
    expect(h.verify).toHaveBeenCalledWith({ token_hash: 'hash-abc', type: 'magiclink' })
  })

  it('falls back to the PKCE code form when that is what arrives', async () => {
    const h = harness()
    const result = await completeMagicLink(h.auth, `${ORIGIN}/auth/confirm?code=pkce-code`)

    expect(result.status).toBe('success')
    expect(h.exchange).toHaveBeenCalledWith('pkce-code')
    expect(h.verify).not.toHaveBeenCalled()
  })

  it('narrows an unexpected type rather than passing it through', async () => {
    const h = harness()
    await completeMagicLink(h.auth, `${ORIGIN}/auth/confirm?token_hash=h&type=not-a-real-type`)
    expect(h.verify).toHaveBeenCalledWith({ token_hash: 'h', type: 'magiclink' })
  })

  it('explains an expired link', async () => {
    const h = harness({ verifyError: { message: 'Email link is invalid or has expired' } })
    const result = await completeMagicLink(h.auth, `${ORIGIN}/auth/confirm?token_hash=old`)

    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toMatch(/expired/i)
    expect(result.message).toMatch(/request a new one/i)
  })

  it('explains a link that has already been used', async () => {
    const h = harness({ verifyError: { message: 'Token has already been used' } })
    const result = await completeMagicLink(h.auth, `${ORIGIN}/auth/confirm?token_hash=spent`)

    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toMatch(/already have been used|no longer valid/i)
  })

  it('verifies a given token hash exactly once', async () => {
    const h = harness()
    const href = `${ORIGIN}/auth/confirm?token_hash=one-shot`
    await completeMagicLink(h.auth, href)
    await completeMagicLink(h.auth, href)
    expect(h.verify).toHaveBeenCalledTimes(1)
  })

  it('explains the same-browser requirement when PKCE has no verifier', async () => {
    const h = harness({ exchangeError: { message: 'invalid request: both auth code and code verifier should be non-empty' } })
    const result = await completeMagicLink(h.auth, `${ORIGIN}/auth/confirm?code=abc`)

    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toMatch(/same browser/i)
  })

  it('reports an expired link carried as URL error parameters', async () => {
    const h = harness()
    const result = await completeMagicLink(
      h.auth,
      `${ORIGIN}/auth/confirm#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`,
    )
    expect(result.status).toBe('error')
    if (result.status !== 'error') return
    expect(result.message).toMatch(/expired/i)
  })
})

describe('URL credential cleanup', () => {
  it('removes an OAuth code from the query', () => {
    expect(cleanAuthParamsFromUrl(`${ORIGIN}/auth/callback?code=secret-code&next=%2Falerts`)).toBe(
      '/auth/callback',
    )
  })

  it('removes a token hash and its type', () => {
    expect(
      cleanAuthParamsFromUrl(`${ORIGIN}/auth/confirm?token_hash=secret-hash&type=magiclink`),
    ).toBe('/auth/confirm')
  })

  it('removes implicit-flow tokens from the fragment', () => {
    const cleaned = cleanAuthParamsFromUrl(
      `${ORIGIN}/auth/confirm#access_token=eyJhbGciOi.secret&refresh_token=r-secret&expires_in=3600&token_type=bearer`,
    )
    expect(cleaned).not.toContain('access_token')
    expect(cleaned).not.toContain('refresh_token')
    expect(cleaned).not.toContain('eyJhbGciOi')
  })

  it('removes error parameters once they have been shown', () => {
    expect(
      cleanAuthParamsFromUrl(
        `${ORIGIN}/auth/confirm?error=access_denied&error_code=otp_expired&error_description=nope`,
      ),
    ).toBe('/auth/confirm')
  })

  it('leaves unrelated parameters alone', () => {
    expect(cleanAuthParamsFromUrl(`${ORIGIN}/alerts?severity=critical&code=abc`)).toBe(
      '/alerts?severity=critical',
    )
  })

  it('leaves no credential anywhere in the result', () => {
    const cleaned = cleanAuthParamsFromUrl(
      `${ORIGIN}/auth/callback?code=c-secret&state=s-secret&token_hash=t-secret#access_token=a-secret`,
    )
    for (const secret of ['c-secret', 's-secret', 't-secret', 'a-secret']) {
      expect(cleaned).not.toContain(secret)
    }
  })
})

describe('the sign-in experience offers no password and no signup', () => {
  const signInSource = readFileSync('src/pages/SignInPage.tsx', 'utf8')

  it('renders no password input', () => {
    expect(signInSource).not.toMatch(/type="password"/)
    expect(signInSource).not.toMatch(/autoComplete="current-password"/)
    expect(signInSource).not.toMatch(/autoComplete="new-password"/)
  })

  it('offers no account creation or self-registration control', () => {
    // Comments stripped: the file explains at length that these are absent, and
    // that explanation must not read as the thing it rules out.
    const code = withoutComments(signInSource)
    expect(code).not.toMatch(/Create account/i)
    expect(code).not.toMatch(/Sign up/i)
    expect(code).not.toMatch(/\bsignUp\b/)
    expect(code).not.toMatch(/Create an account/i)
  })

  it('offers no password reset, because there are no passwords', () => {
    const code = withoutComments(signInSource)
    expect(code).not.toMatch(/forgot password/i)
    expect(code).not.toMatch(/reset.{0,10}password/i)
    expect(code).not.toMatch(/resetPasswordForEmail/)
  })

  it('states that access is restricted', () => {
    expect(signInSource).toMatch(/Access is restricted/)
    expect(signInSource).toMatch(/no self-registration/i)
  })

  it('leads with Microsoft', () => {
    expect(signInSource).toMatch(/Continue with Microsoft/)
    expect(signInSource).toMatch(/Email me a sign-in link/)
  })
})

describe('no password authentication remains in the application', () => {
  it('never calls signInWithPassword', () => {
    const offenders = shippedSourceFiles().filter((file) =>
      readFileSync(file, 'utf8').includes('signInWithPassword'),
    )
    expect(offenders).toEqual([])
  })

  it('never calls signUp', () => {
    const offenders = shippedSourceFiles().filter((file) =>
      /\bauth\s*\.\s*signUp\s*\(/.test(readFileSync(file, 'utf8')),
    )
    expect(offenders).toEqual([])
  })
})

describe('no server-side secret is reachable from the browser', () => {
  const FORBIDDEN = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_DB_PASSWORD',
    'SUPABASE_ACCESS_TOKEN',
    'RESEND_API_KEY',
    'SMTP_PASSWORD',
    'SMTP_PASS',
    'AZURE_CLIENT_SECRET',
    'ONESIGNAL_REST_API_KEY',
  ]

  it('reads none of them from import.meta.env', () => {
    const offenders: string[] = []
    for (const file of shippedSourceFiles()) {
      const text = readFileSync(file, 'utf8')
      for (const name of FORBIDDEN) {
        const pattern = new RegExp(`import\\.meta\\.env\\s*(\\.\\s*${name}|\\[\\s*['"\`]${name})`)
        if (pattern.test(text)) offenders.push(`${file}: ${name}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('declares no VITE_ alias for any of them', () => {
    const declarations = readFileSync('src/vite-env.d.ts', 'utf8')
    for (const name of FORBIDDEN) {
      expect(declarations).not.toMatch(new RegExp(`VITE_${name}`))
    }
  })

  it('keeps the Azure client id and secret out of the browser entirely', () => {
    // Both live in the Supabase dashboard's Azure provider configuration.
    // Supabase performs the token exchange; the browser never sees either.
    for (const file of shippedSourceFiles()) {
      expect(withoutComments(readFileSync(file, 'utf8')), file).not.toMatch(
        /AZURE_CLIENT_ID|azureClientId|client_secret/,
      )
    }
  })

  it('never needs a Resend credential: Supabase sends the mail', () => {
    // Resend is configured as Supabase's SMTP provider in the dashboard. No
    // application code calls it, and no key belongs in this repository.
    for (const file of shippedSourceFiles()) {
      expect(withoutComments(readFileSync(file, 'utf8')), file).not.toMatch(
        /RESEND_API_KEY|api\.resend\.com|from 'resend'/i,
      )
    }
  })
})

describe('the provisioning workflow is server-side only', () => {
  /*
   * Provisioning is three files: the command line, the decisions, and the
   * Supabase adapter. These scan all of them together, because a guarantee that
   * holds only in the file the test happens to name is not a guarantee — the
   * previous revision asserted "no password" against the CLI alone, and would
   * have kept passing if the account creation moved elsewhere and grew one.
   *
   * The behaviour of the decisions is covered properly in
   * src/services/provisioning/provisionUser.test.ts. What is checked here is
   * what a behavioural test cannot see: that no path anywhere in the surface
   * sets a password, and that none of it can reach the browser.
   */
  const PROVISIONING_FILES = [
    'scripts/provision-user.mjs',
    'scripts/lib/provisionUser.mjs',
    'scripts/lib/supabaseStore.mjs',
  ]
  const sources = PROVISIONING_FILES.map((file) => ({
    file,
    text: readFileSync(file, 'utf8'),
  }))
  const surface = sources.map((source) => source.text).join('\n')

  it('creates a confirmed user with no password', () => {
    expect(surface).toMatch(/email_confirm:\s*true/)
    expect(surface).not.toMatch(/generatePassword|randomPassword/)
  })

  it('sets no password on any path, in any of its files', () => {
    for (const { file, text } of sources) {
      // Comments stripped: several of these files explain at length why no
      // password is set, and that prose must not be what makes this pass.
      expect(withoutComments(text), `${file} sets a password`).not.toMatch(
        /\bpassword\s*:\s*\S/,
      )
    }
  })

  it('sends no invitation', () => {
    // A call, not the comment that explains why this one is not used.
    expect(surface).not.toMatch(/inviteUserByEmail\s*\(/)
    expect(surface).toMatch(/admin\.createUser\(/)
  })

  it('unwinds its own writes when a later step fails', () => {
    expect(surface).toMatch(/undo/)
    expect(surface).toMatch(/deleteAuthUser/)
    expect(surface).toMatch(/admin\.deleteUser\(/)
  })

  it('refuses to authorize an account that still has a password', () => {
    // The enforcement point. Hiding the password field in the UI does not stop
    // Supabase accepting grant_type=password, so provisioning is where an
    // account carrying one is actually turned away.
    expect(surface).toMatch(/password_credential_present/)
    expect(surface).toMatch(/openiwatch_user_has_password/)
  })

  it('is not importable from the browser bundle', () => {
    const offenders = shippedSourceFiles().filter((file) => {
      const text = readFileSync(file, 'utf8')
      return (
        text.includes('provision-user') ||
        text.includes('scripts/lib/') ||
        text.includes('supabaseStore')
      )
    })
    expect(offenders).toEqual([])
  })
})
