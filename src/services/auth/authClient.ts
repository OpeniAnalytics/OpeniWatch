/**
 * Authentication flows.
 *
 * OpeniWatch authenticates with Microsoft Entra ID as the primary route and an
 * emailed magic link as the fallback. There is no password anywhere in the
 * normal sign-in experience, and no self-registration.
 *
 * Everything here is written against a small structural interface rather than
 * the Supabase client itself, so the rules — which provider, which scopes,
 * which redirect, that a code is exchanged exactly once, that a hostile `next`
 * is refused — are testable without a browser or a network.
 *
 * **Authentication is not authorization.** Nothing in this file grants access
 * to anything. A successful Microsoft sign-in from a valid Entra tenant yields
 * a Supabase user and nothing more; whether that user may see OpeniWatch data
 * is decided afterwards by organization membership and enforced by RLS.
 */

/**
 * The provider id configured in the Supabase dashboard for Entra ID.
 *
 * Supabase calls Entra ID "azure" — the name predates the Entra rebrand. The
 * literal type matters: it keeps this interface assignable from the real
 * `supabase.auth`, whose own signature accepts only known provider names.
 */
export const MICROSOFT_PROVIDER = 'azure' as const

/** Where Microsoft returns the operator after they authenticate. */
export const OAUTH_CALLBACK_PATH = '/auth/callback'

/** Where an emailed magic link returns the operator. */
export const MAGIC_LINK_PATH = '/auth/confirm'

/**
 * Scopes requested from Entra ID.
 *
 * `email` only. OpeniWatch identifies an operator by their address and takes
 * everything else — name, role, organization — from its own records. Asking
 * for directory or profile scopes would mean holding data the product has no
 * use for and cannot justify to a tenant administrator.
 */
export const MICROSOFT_SCOPES = 'email'

interface AuthResponseError {
  message: string
  status?: number
  code?: string
}

interface SessionCarrier {
  session: unknown | null
}

/**
 * The email OTP kinds a magic link can arrive as.
 *
 * Mirrors Supabase's own union rather than accepting any string, so an
 * unexpected `type` in a crafted URL cannot be passed straight through to
 * `verifyOtp`.
 */
export type EmailOtpType = 'magiclink' | 'signup' | 'invite' | 'recovery' | 'email_change' | 'email'

const EMAIL_OTP_TYPES: readonly EmailOtpType[] = [
  'magiclink',
  'signup',
  'invite',
  'recovery',
  'email_change',
  'email',
]

/** Narrows an untrusted `type` parameter, defaulting to a magic link. */
function asEmailOtpType(value: string | null): EmailOtpType {
  return EMAIL_OTP_TYPES.includes(value as EmailOtpType) ? (value as EmailOtpType) : 'magiclink'
}

/** The subset of `supabase.auth` these flows use. */
export interface SupabaseAuthLike {
  signInWithOAuth(params: {
    provider: 'azure'
    options: { scopes?: string; redirectTo?: string }
  }): Promise<{ error: AuthResponseError | null }>

  signInWithOtp(params: {
    email: string
    options: { shouldCreateUser: boolean; emailRedirectTo: string }
  }): Promise<{ error: AuthResponseError | null }>

  exchangeCodeForSession(
    authCode: string,
  ): Promise<{ data: SessionCarrier; error: AuthResponseError | null }>

  verifyOtp(params: {
    token_hash: string
    type: EmailOtpType
  }): Promise<{ data: SessionCarrier; error: AuthResponseError | null }>
}

/**
 * Query and fragment parameters that must never survive in the address bar or
 * in browser history once they have been handled.
 *
 * `code` and `token_hash` are single-use credentials. `access_token` and
 * `refresh_token` appear in the fragment under the implicit flow. The error
 * parameters are not secret but are meaningless once shown, and they make a
 * bookmarked or shared URL confusing.
 */
const CREDENTIAL_PARAMS = [
  'code',
  'token_hash',
  'token',
  'access_token',
  'refresh_token',
  'provider_token',
  'provider_refresh_token',
  'expires_in',
  'expires_at',
  'state',
  'type',
  'error',
  'error_code',
  'error_description',
]

/**
 * Control characters, which never legitimately appear in an in-app path.
 *
 * `no-control-regex` exists to catch these by accident. Matching them is the
 * entire purpose here: a newline or a NUL smuggled into a redirect target is
 * how a parser downstream gets confused about where a value ends.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/**
 * Reduces a caller-supplied post-login target to something safe to navigate to.
 *
 * Only a path on this origin is ever returned. An absolute URL, a
 * protocol-relative `//evil.example`, a backslash variant, or anything carrying
 * a scheme is discarded in favour of the overview — an open redirect on a
 * sign-in route is how a credible phishing page gets a real domain in front of
 * it.
 *
 * `/auth/*` is also refused, because returning there after signing in would
 * loop through the callback with no credential left to consume.
 */
export function safeNext(raw: string | null | undefined): string {
  if (!raw) return '/'
  const value = raw.trim()
  if (!value.startsWith('/')) return '/'
  // `//host` and `/\host` are both read as protocol-relative by browsers.
  if (value.startsWith('//') || value.startsWith('/\\')) return '/'
  if (value.includes('://')) return '/'
  if (CONTROL_CHARACTERS.test(value)) return '/'
  if (value.startsWith(OAUTH_CALLBACK_PATH) || value.startsWith(MAGIC_LINK_PATH)) return '/'
  return value
}

/** The absolute URL Supabase should return the operator to. */
export function buildRedirectUrl(origin: string, path: string, next?: string | null): string {
  const url = new URL(path, origin)
  const target = safeNext(next)
  if (target !== '/') url.searchParams.set('next', target)
  return url.toString()
}

/**
 * Starts Microsoft sign-in.
 *
 * No Azure client id or secret is involved here or anywhere else in the
 * browser: both live in the Supabase dashboard's Azure provider configuration,
 * and Supabase performs the token exchange server-side.
 */
export async function startMicrosoftSignIn(
  auth: SupabaseAuthLike,
  origin: string,
  next?: string | null,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { error } = await auth.signInWithOAuth({
    provider: MICROSOFT_PROVIDER,
    options: {
      scopes: MICROSOFT_SCOPES,
      redirectTo: buildRedirectUrl(origin, OAUTH_CALLBACK_PATH, next),
    },
  })
  if (error) return { ok: false, message: 'Microsoft sign-in could not be started. Try again.' }
  return { ok: true }
}

/**
 * The one message every magic-link request produces.
 *
 * Deliberately identical whether the address is unknown, known but
 * unauthorized, known and authorized, or rate limited. Anything else turns the
 * sign-in form into a directory of who works here, which for a security
 * operations product is a disclosure worth avoiding.
 */
export const MAGIC_LINK_GENERIC_MESSAGE =
  'If that address belongs to an authorized OpeniWatch account, a sign-in link is on its way. The link expires shortly and can be used once.'

/**
 * Requests a magic link.
 *
 * `shouldCreateUser: false` is what keeps self-registration closed: an address
 * with no existing account gets no account and no email, and — because the
 * response below is fixed — the sender cannot tell which happened.
 */
export async function requestMagicLink(
  auth: SupabaseAuthLike,
  origin: string,
  email: string,
  next?: string | null,
): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const address = email.trim()
  if (!address || !address.includes('@')) {
    // A malformed address is a typo, not an enumeration signal, so this one may
    // be specific.
    return { ok: false, message: 'Enter a valid email address.' }
  }

  const { error } = await auth.signInWithOtp({
    email: address,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: buildRedirectUrl(origin, MAGIC_LINK_PATH, next),
    },
  })

  /*
   * The error is deliberately discarded.
   *
   * Supabase answers "Signups not allowed for otp" for an unknown address, and
   * a rate-limit error when one address is hammered. Surfacing either would
   * confirm or deny that an account exists. The operator sees the same sentence
   * in every case; the real outcome goes to the Supabase auth log, where an
   * administrator can see it and an attacker cannot.
   */
  void error
  return { ok: true, message: MAGIC_LINK_GENERIC_MESSAGE }
}

export type CompletionResult =
  | { status: 'success'; next: string }
  | { status: 'error'; message: string }

/**
 * Codes and token hashes already handed to Supabase in this page's lifetime.
 *
 * A single-use credential must be exchanged exactly once. React re-runs effects
 * in development, a bookmarked callback URL can be revisited, and a double
 * render would otherwise send the same code twice — the second attempt fails,
 * and without this guard that failure would be reported to an operator who had
 * in fact just signed in successfully.
 */
const consumedCredentials = new Set<string>()

/** Test seam: forget what has been consumed. */
export function resetConsumedCredentials(): void {
  consumedCredentials.clear()
}

/** Reads a parameter from the query string or the URL fragment. */
function readParam(url: URL, key: string): string | null {
  const fromQuery = url.searchParams.get(key)
  if (fromQuery) return fromQuery
  const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
  if (!fragment) return null
  return new URLSearchParams(fragment).get(key)
}

/** A provider error carried in the URL, phrased for an operator. */
function describeUrlError(url: URL): string | null {
  const code = readParam(url, 'error_code')
  const error = readParam(url, 'error')
  const description = readParam(url, 'error_description')
  if (!code && !error && !description) return null

  const haystack = `${code ?? ''} ${error ?? ''} ${description ?? ''}`.toLowerCase()
  if (haystack.includes('expired')) {
    return 'That sign-in link has expired. Request a new one — links are valid for a short time and can be used once.'
  }
  if (haystack.includes('access_denied') || haystack.includes('denied')) {
    return 'Sign-in was cancelled or refused. If this is unexpected, contact your OpeniWatch administrator.'
  }
  return 'That sign-in link is no longer valid. It may already have been used, or it may have expired. Request a new one.'
}

/** Turns a Supabase failure into something an operator can act on. */
function describeExchangeError(message: string): string {
  const haystack = message.toLowerCase()
  if (haystack.includes('expired')) {
    return 'That sign-in link has expired. Request a new one — links are valid for a short time and can be used once.'
  }
  if (haystack.includes('verifier') || haystack.includes('code challenge')) {
    // PKCE keeps the verifier in the browser that asked for the link.
    return 'This sign-in link must be opened in the same browser that requested it. Request a new link and open it here.'
  }
  if (
    haystack.includes('already') ||
    haystack.includes('used') ||
    haystack.includes('invalid') ||
    haystack.includes('not found')
  ) {
    return 'That sign-in link is no longer valid. It may already have been used, or it may have expired. Request a new one.'
  }
  return 'Sign-in could not be completed. Request a new link and try again.'
}

/**
 * Completes the Microsoft OAuth callback.
 *
 * The Supabase client is configured with `detectSessionInUrl: false`, so it
 * does not race this function for the code — the exchange happens here, once,
 * and nowhere else.
 */
export async function completeOAuthCallback(
  auth: SupabaseAuthLike,
  href: string,
): Promise<CompletionResult> {
  const url = new URL(href)
  const next = safeNext(url.searchParams.get('next'))

  const urlError = describeUrlError(url)
  if (urlError) return { status: 'error', message: urlError }

  const code = readParam(url, 'code')
  if (!code) {
    return {
      status: 'error',
      message: 'This sign-in link is incomplete. Start again from the sign-in screen.',
    }
  }

  if (consumedCredentials.has(code)) {
    // Already exchanged in this page's lifetime. The session it produced is the
    // real outcome, so report success rather than a spurious failure.
    return { status: 'success', next }
  }
  consumedCredentials.add(code)

  const { data, error } = await auth.exchangeCodeForSession(code)
  if (error || !data?.session) {
    return { status: 'error', message: describeExchangeError(error?.message ?? '') }
  }
  return { status: 'success', next }
}

/**
 * Completes an emailed magic link.
 *
 * Supabase can deliver the link in either of two shapes, depending on the email
 * template configured in the dashboard, so both are handled:
 *
 *   - `?token_hash=...&type=magiclink` — from a `{{ .TokenHash }}` template.
 *     Verified with `verifyOtp`. This form works in any browser, which matters
 *     because operators routinely read mail on a phone and work on a desktop.
 *   - `?code=...` — the PKCE form from the default `{{ .ConfirmationURL }}`
 *     template. Exchanged with `exchangeCodeForSession`, and only succeeds in
 *     the browser that requested it, because that is where the code verifier
 *     was stored.
 *
 * The token-hash template is the one to configure; see docs/AUTHENTICATION.md.
 */
export async function completeMagicLink(
  auth: SupabaseAuthLike,
  href: string,
): Promise<CompletionResult> {
  const url = new URL(href)
  const next = safeNext(url.searchParams.get('next'))

  const urlError = describeUrlError(url)
  if (urlError) return { status: 'error', message: urlError }

  const tokenHash = readParam(url, 'token_hash')
  if (tokenHash) {
    if (consumedCredentials.has(tokenHash)) return { status: 'success', next }
    consumedCredentials.add(tokenHash)

    const type = asEmailOtpType(readParam(url, 'type'))
    const { data, error } = await auth.verifyOtp({ token_hash: tokenHash, type })
    if (error || !data?.session) {
      return { status: 'error', message: describeExchangeError(error?.message ?? '') }
    }
    return { status: 'success', next }
  }

  const code = readParam(url, 'code')
  if (code) return completeOAuthCallback(auth, href)

  return {
    status: 'error',
    message: 'This sign-in link is incomplete. Request a new one from the sign-in screen.',
  }
}

/**
 * Strips every authentication parameter from a URL.
 *
 * Returns the path the address bar should show. Applied with
 * `history.replaceState`, so the credential is not left in the address bar, is
 * not carried into a bookmark or a shared screenshot, and is not reachable with
 * the back button.
 */
export function cleanAuthParamsFromUrl(href: string): string {
  const url = new URL(href)
  for (const key of CREDENTIAL_PARAMS) url.searchParams.delete(key)
  url.searchParams.delete('next')

  if (url.hash) {
    const fragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash
    const params = new URLSearchParams(fragment)
    let touched = false
    for (const key of CREDENTIAL_PARAMS) {
      if (params.has(key)) {
        params.delete(key)
        touched = true
      }
    }
    // A fragment that existed only to carry credentials goes entirely.
    if (touched) {
      const rest = params.toString()
      url.hash = rest ? `#${rest}` : ''
    }
  }

  return `${url.pathname}${url.search}${url.hash}`
}
