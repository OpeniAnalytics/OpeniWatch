/**
 * Resolving the elevated Supabase key inside an Edge Function.
 *
 * Supabase injects two JSON dictionaries into every function's environment:
 *
 *   SUPABASE_PUBLISHABLE_KEYS  {"default":"sb_publishable_..."}
 *   SUPABASE_SECRET_KEYS       {"default":"sb_secret_..."}
 *
 * These replace the single `SUPABASE_SERVICE_ROLE_KEY` variable. They are
 * dictionaries rather than scalars because a project can hold several keys at
 * once, which is what makes rotation possible without a window where nothing
 * works: publish the new key, move consumers, revoke the old one.
 *
 * ---------------------------------------------------------------------------
 * These keys are NOT JWTs
 * ---------------------------------------------------------------------------
 *
 * A legacy `service_role` key was a signed JWT, so PostgREST could read a role
 * claim straight out of it and code could — and did — pass it as a user token.
 * An `sb_secret_...` key carries no claims and cannot be decoded.
 *
 * Two consequences worth stating, because both are easy to get wrong:
 *
 *   - It goes in the `apikey` header. Supabase also accepts it as a Bearer
 *     token on its own REST endpoints, but it must never be presented anywhere
 *     that expects a *user* JWT — nothing downstream can extract a subject, an
 *     expiry or a role from it, and code that tries will read undefined and
 *     may fall open.
 *   - A function that verifies an incoming user JWT must keep doing that
 *     against the caller's token. The secret key is this function's own
 *     credential and says nothing about who called it.
 */

/** Reads one named key out of a Supabase-injected JSON dictionary. */
function readKeyFromDictionary(variable: string, name: string): string {
  const raw = Deno.env.get(variable)
  if (!raw) return ''
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ''
    const value = (parsed as Record<string, unknown>)[name]
    return typeof value === 'string' ? value : ''
  } catch {
    // A malformed dictionary is a platform-side problem. Returning empty makes
    // the caller fail closed with its own configuration error rather than
    // throwing an unhandled parse error at request time.
    return ''
  }
}

/**
 * The secret key this function should use for elevated project access.
 *
 * Order of preference:
 *
 *   1. `SUPABASE_SECRET_KEYS` — the current model, keyed by name.
 *   2. `SUPABASE_SECRET_KEY` — a plain scalar, for local `supabase functions
 *      serve` and for self-hosted deployments that do not inject the
 *      dictionary.
 *
 * The legacy `SUPABASE_SERVICE_ROLE_KEY` is deliberately not consulted. Falling
 * back to it would mean a function kept working after the migration while still
 * depending on a key the project is retiring, and nobody would find out until
 * it was revoked.
 */
export function getSecretKey(name = 'default'): string {
  return readKeyFromDictionary('SUPABASE_SECRET_KEYS', name) || Deno.env.get('SUPABASE_SECRET_KEY') || ''
}

/**
 * The publishable key, for the rare call that should run as an anonymous user.
 *
 * Not used by OpeniWatch's current functions — every one of them needs elevated
 * access — but provided so a future function does not reach for the secret key
 * out of convenience.
 */
export function getPublishableKey(name = 'default'): string {
  return (
    readKeyFromDictionary('SUPABASE_PUBLISHABLE_KEYS', name) ||
    Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ||
    ''
  )
}

/** True for a well-formed secret key. Used to fail closed on a misconfiguration. */
export function isSecretKey(value: string): boolean {
  return /^sb_secret_[A-Za-z0-9_-]{10,}$/.test(value)
}
