import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Authentication is not authorization.
 *
 * These assert the seam that matters most in this change: a Supabase user who
 * has genuinely proved who they are still gets nothing from OpeniWatch until an
 * administrator has granted them a membership.
 *
 * The behaviour lives in `hydrateSession`, which reaches for the network and
 * is therefore asserted here against its source rather than executed. The
 * database half of the same rule — that RLS refuses the rows in the first
 * place — is proven for real against PostgreSQL by `npm run test:rls`, and the
 * live half by `npm run validate:staging`. This file's job is to stop the
 * client-side gate being removed or reordered without anyone noticing.
 */

const provider = readFileSync('src/data/supabase/provider.ts', 'utf8')
const dataContext = readFileSync('src/app/DataContext.tsx', 'utf8')
const app = readFileSync('src/App.tsx', 'utf8')
const notAuthorized = readFileSync('src/pages/auth/NotAuthorizedPage.tsx', 'utf8')
const workflow = readFileSync('src/data/workflow.ts', 'utf8')

describe('an authenticated user with no membership is refused', () => {
  it('raises a distinct error rather than a generic failure', () => {
    expect(workflow).toMatch(/export class NotAuthorizedError extends Error/)
    // Carries the address so the screen can tell the person what to quote.
    expect(workflow).toMatch(/readonly email: string/)
  })

  it('refuses a user with no profile', () => {
    expect(provider).toMatch(/if \(!profileRow\) \{[\s\S]{0,200}NotAuthorizedError/)
  })

  it('refuses a user whose profile has been deactivated', () => {
    // A leaver keeps their Microsoft account; they must not keep their access.
    expect(provider).toMatch(/is_active\?: boolean[\s\S]{0,120}NotAuthorizedError/)
  })

  it('refuses a user with no organization membership', () => {
    expect(provider).toMatch(/memberships\.length === 0[\s\S]{0,200}NotAuthorizedError/)
  })

  it('never invents a membership for an authenticated user', () => {
    // Self-provisioning on first sign-in would let anyone in a valid Entra
    // tenant grant themselves access simply by visiting the site.
    const hydrate = provider.slice(
      provider.indexOf('private async hydrateSession'),
      provider.indexOf('private async requireActor'),
    )
    expect(hydrate.length).toBeGreaterThan(0)
    expect(hydrate).not.toMatch(/\.insert\(/)
    expect(hydrate).not.toMatch(/\.upsert\(/)
  })

  it('derives the organization from the membership, not from a role row', () => {
    // Reading it from user_roles could yield an organization the user is not a
    // member of, which every downstream RLS check would then be asked about.
    expect(provider).toMatch(/const organizationId = \(memberships\[0\]/)
  })
})

describe('the refusal reaches the operator as a screen, not a crash', () => {
  it('is caught during session restoration', () => {
    expect(dataContext).toMatch(/catch \(error\)/)
    expect(dataContext).toMatch(/error instanceof NotAuthorizedError/)
  })

  it('is rendered instead of the application shell', () => {
    // Before <SignInPage />, so an authorized-looking user is not invited to
    // authenticate again and land in the same place with no explanation.
    const authorizationGate = app.indexOf('if (authorization)')
    const signInGate = app.indexOf('if (!session) return <SignInPage />')
    expect(authorizationGate).toBeGreaterThan(-1)
    expect(signInGate).toBeGreaterThan(-1)
    expect(authorizationGate).toBeLessThan(signInGate)
  })

  it('says access is not authorized and offers sign-out', () => {
    expect(notAuthorized).toMatch(/Access not authorized/)
    expect(notAuthorized).toMatch(/onSignOut/)
    expect(notAuthorized).toMatch(/Sign out/)
  })

  it('exposes no operational data', () => {
    // No provider query, no reference data, no alert of any kind.
    expect(notAuthorized).not.toMatch(/useProviderQuery|useData\(\)/)
    expect(notAuthorized).not.toMatch(/alerts|signals|locations|programs/i)
  })

  it('names no organization, program or colleague', () => {
    // The person reading it is, so far as OpeniWatch is concerned, a stranger.
    expect(notAuthorized).not.toMatch(/organization\.name|program\.name|fullName/)
  })
})

describe('authorized roles are unaffected', () => {
  it('still resolves a role from user_roles with the same precedence', () => {
    // This change must not alter the existing authorization model.
    expect(provider).toMatch(/const precedence: AppRole\[\] = \[/)
    for (const role of [
      'super_admin',
      'program_admin',
      'analyst',
      'soc_manager',
      'soc_operator',
      'viewer',
    ]) {
      expect(provider).toContain(`'${role}'`)
    }
  })

  it('still carries program memberships into the session', () => {
    expect(provider).toMatch(/programIds: \(programRows \?\? \[\]\)/)
  })

  it('leaves every RLS policy untouched', () => {
    // The gate added here is a second, client-side check. The database is still
    // the boundary, and no migration was changed to make this work.
    const rls = readFileSync('supabase/migrations/0007_row_level_security.sql', 'utf8')
    expect(rls).toMatch(/enable row level security/i)
    expect(rls).toMatch(/force row level security/i)
  })
})

describe('sign-out', () => {
  it('clears the session and the authorization refusal together', () => {
    // Leaving the refusal set would strand the next person on this browser.
    expect(dataContext).toMatch(/setSession\(null\)\s*\n\s*setAuthorization\(null\)/)
  })

  it('detaches the OneSignal identity before the session goes', () => {
    expect(dataContext).toMatch(/pushClient\.clearIdentity\(\)[\s\S]{0,120}provider\.signOut\(\)/)
  })
})

describe('OneSignal identity follows the new authentication', () => {
  it('associates the device after a session is established', () => {
    // Unchanged by this work, and asserted here so the auth rewrite cannot
    // quietly drop it: the effect keys on `session`, which is now set by the
    // OAuth and magic-link paths rather than by a password sign-in.
    expect(dataContext).toMatch(/pushClient\.syncIdentity\(session\.userId\)/)
  })

  it('runs only for an authorized session', () => {
    // The effect returns early without a session, and `authorization` prevents
    // one from existing, so an unauthorized user never registers a device.
    expect(dataContext).toMatch(/if \(!session\) return\s*\n\s*void pushClient\.syncIdentity/)
  })
})

describe('the browser client is configured for a single, safe exchange', () => {
  const client = readFileSync('src/data/supabase/client.ts', 'utf8')

  it('uses PKCE rather than the implicit flow', () => {
    // auth-js defaults to implicit, which returns tokens in the URL fragment.
    expect(client).toMatch(/flowType: 'pkce'/)
  })

  it('does not let the SDK consume the code behind the application', () => {
    // Two consumers racing for a single-use credential means the loser reports
    // a failure for a sign-in that actually succeeded.
    expect(client).toMatch(/detectSessionInUrl: false/)
  })

  it('still persists and refreshes the session across a reload', () => {
    expect(client).toMatch(/persistSession: true/)
    expect(client).toMatch(/autoRefreshToken: true/)
  })
})

describe('password authentication is gone from the Supabase provider', () => {
  it('refuses a password sign-in attempt', () => {
    expect(provider).toMatch(/Password sign-in is not available/)
  })

  it('calls no password API', () => {
    expect(provider).not.toMatch(/signInWithPassword|resetPasswordForEmail|updateUser\(\{ password/)
  })
})
