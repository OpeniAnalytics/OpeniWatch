/**
 * Provisioning one authorized OpeniWatch user.
 *
 * This module holds the decisions. It talks to a small "store" port rather than
 * to Supabase directly, for two reasons: the rules below are the security
 * boundary and deserve real tests, and a PostgREST chain is close to untestable
 * without a live database. `supabaseStore.mjs` is the production adapter;
 * the test suite passes an in-memory one.
 *
 * ---------------------------------------------------------------------------
 * Authentication is not authorization
 * ---------------------------------------------------------------------------
 *
 * An auth user existing means someone can prove who they are. It says nothing
 * about whether they may see a protected location's alerts. Every grant below
 * is written deliberately, and an existing Auth identity never implies one.
 *
 * ---------------------------------------------------------------------------
 * Passwords
 * ---------------------------------------------------------------------------
 *
 * OpeniWatch's approved sign-in methods are Microsoft Entra and emailed magic
 * links. Provisioning never sets a password, and it refuses to grant
 * authorization to an account that still carries one, because a password on an
 * authorized account is a second way in that nobody chose.
 *
 * That refusal is the enforcement point this repository actually controls.
 * Whether the project accepts `grant_type=password` at all is a Supabase
 * setting, not something a script can assert.
 */

export const VALID_ROLES = [
  'super_admin',
  'program_admin',
  'analyst',
  'soc_manager',
  'soc_operator',
  'viewer',
]

/** Thrown for every refusal, so a caller can tell them apart by `code`. */
export class ProvisioningError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ProvisioningError'
    this.code = code
  }
}

/**
 * Addresses are matched case-insensitively and trimmed.
 *
 * Without this, "Casey@Example.com" and "casey@example.com" provision two
 * separate auth users for one person — and the second one would sit there
 * unauthorized while the administrator believed access had been granted.
 */
export function normalizeEmail(raw) {
  if (typeof raw !== 'string') throw new ProvisioningError('email_invalid', '--email is required.')
  const email = raw.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ProvisioningError('email_invalid', `"${raw}" is not an email address.`)
  }
  return email
}

/**
 * Provisions, or re-provisions, one user.
 *
 * Idempotent by construction: every step asks what is already there and only
 * writes the difference. Running it twice produces the same account and the
 * second run reports no changes.
 */
export async function provisionUser(store, options) {
  const email = normalizeEmail(options.email)
  const fullName = (options.fullName ?? '').trim()
  const role = options.role
  const dryRun = Boolean(options.dryRun)

  if (!fullName) throw new ProvisioningError('name_required', '--name is required.')
  if (!VALID_ROLES.includes(role)) {
    throw new ProvisioningError(
      'role_invalid',
      `--role must be one of: ${VALID_ROLES.join(', ')}`,
    )
  }

  const actions = []
  const warnings = []
  /** Rows this run created, unwound in reverse if a later step fails. */
  const created = []

  const record = (what, undo) => created.push({ what, undo })

  const organization = await store.findOrganizationBySlug(options.organizationSlug)
  if (!organization) {
    throw new ProvisioningError(
      'organization_not_found',
      `No organization with slug "${options.organizationSlug}".`,
    )
  }

  let program = null
  if (options.programSlug) {
    program = await store.findProgramBySlug(options.programSlug)
    if (!program) {
      throw new ProvisioningError(
        'program_not_found',
        `No program with slug "${options.programSlug}".`,
      )
    }
    if (program.organizationId !== organization.id) {
      throw new ProvisioningError(
        'program_wrong_organization',
        `Program "${options.programSlug}" belongs to a different organization than "${options.organizationSlug}".`,
      )
    }
  }

  // ---- Auth user ----------------------------------------------------------
  // Look first, then decide. The previous revision called createUser and read
  // "already exists" out of the failure, which also swallowed real errors.
  const existing = await store.findAuthUserByEmail(email)

  if (existing?.hasPassword) {
    // The check that gives this script its teeth. A password on an account we
    // are about to authorize is an unapproved second way in.
    if (!options.allowPasswordCredential) {
      throw new ProvisioningError(
        'password_credential_present',
        `${email} already has a password credential.\n\n` +
          'OpeniWatch permits Microsoft Entra and emailed magic links only, so\n' +
          'authorizing this account would leave an unapproved way to sign in.\n\n' +
          'Remove the password credential first, then re-run. If you have\n' +
          'confirmed the project rejects password grants and want to proceed\n' +
          'anyway, pass --allow-password-credential to say so deliberately.',
      )
    }
    warnings.push(
      `${email} carries a password credential and was authorized anyway ` +
        '(--allow-password-credential). Password sign-in is not an approved ' +
        'OpeniWatch method; confirm the project rejects password grants.',
    )
  }

  if (dryRun) {
    return {
      email,
      dryRun: true,
      userId: existing?.id ?? null,
      adopted: Boolean(existing),
      organization,
      program,
      role,
      identities: existing?.identities ?? [],
      hasPassword: Boolean(existing?.hasPassword),
      actions: [],
      warnings,
    }
  }

  let userId
  let adopted = false

  if (existing) {
    // Adopt. Never reset the password, never touch the Azure identity, never
    // create a second account for the same person.
    userId = existing.id
    adopted = true
    actions.push({ kind: 'auth_user', change: 'adopted', detail: userId })
  } else {
    const user = await store.createAuthUserWithoutPassword({ email, fullName })
    userId = user.id
    record(`auth user ${userId}`, () => store.deleteAuthUser(userId))
    actions.push({ kind: 'auth_user', change: 'created', detail: userId })
  }

  try {
    // ---- Profile ----------------------------------------------------------
    const profile = await store.findProfileByUserId(userId)
    if (!profile) {
      await store.createProfile({
        userId,
        email,
        fullName,
        title: options.title ?? null,
        phone: options.phone ?? null,
        timeZone: options.timeZone ?? 'America/Chicago',
        isActive: true,
      })
      record(`profile for ${userId}`, () => store.deleteProfile(userId))
      actions.push({ kind: 'profile', change: 'created' })
    } else {
      // A profile that exists but is deactivated is exactly how a leaver is
      // recorded. Reactivating is a real change and is reported as one.
      const patch = {}
      if (profile.isActive !== true) patch.isActive = true
      if (fullName && profile.fullName !== fullName) patch.fullName = fullName
      if (profile.email !== email) patch.email = email

      if (Object.keys(patch).length > 0) {
        const before = { isActive: profile.isActive, fullName: profile.fullName, email: profile.email }
        await store.updateProfile(userId, patch)
        record(`profile changes for ${userId}`, () => store.updateProfile(userId, before))
        actions.push({ kind: 'profile', change: 'updated', detail: Object.keys(patch).join(', ') })
      } else {
        actions.push({ kind: 'profile', change: 'unchanged' })
      }
    }

    // ---- Organization membership ------------------------------------------
    const memberships = await store.listOrganizationMemberships(userId)
    const foreign = memberships.filter((m) => m.organizationId !== organization.id)
    if (foreign.length > 0 && !options.allowAdditionalOrganization) {
      throw new ProvisioningError(
        'existing_other_organization',
        `${email} is already a member of another organization.\n` +
          'Granting a second organization would widen their access across tenants.\n' +
          'Pass --allow-additional-organization if that is intended.',
      )
    }

    if (!memberships.some((m) => m.organizationId === organization.id)) {
      await store.createOrganizationMembership({
        organizationId: organization.id,
        userId,
        isPrimary: memberships.length === 0,
      })
      record(`organization membership in ${organization.slug}`, () =>
        store.deleteOrganizationMembership(organization.id, userId),
      )
      actions.push({ kind: 'organization_membership', change: 'created', detail: organization.slug })
    } else {
      actions.push({ kind: 'organization_membership', change: 'unchanged', detail: organization.slug })
    }

    // ---- Program membership -----------------------------------------------
    if (program) {
      const programMemberships = await store.listProgramMemberships(userId)
      if (!programMemberships.some((m) => m.programId === program.id)) {
        await store.createProgramMembership({ programId: program.id, userId })
        record(`program membership in ${program.slug}`, () =>
          store.deleteProgramMembership(program.id, userId),
        )
        actions.push({ kind: 'program_membership', change: 'created', detail: program.slug })
      } else {
        actions.push({ kind: 'program_membership', change: 'unchanged', detail: program.slug })
      }
    }

    // ---- Role -------------------------------------------------------------
    // Exactly one role in this organization. The unique index keys on the role
    // itself, so a plain upsert with a different role adds a second row rather
    // than replacing the first — and the user would hold both.
    const roles = await store.listRoles(userId, organization.id)
    const wanted = roles.filter((r) => r.role === role)
    const surplus = roles.filter((r) => r.role !== role)

    // Grant before revoking, deliberately. The reverse order reads more
    // naturally but rolls back badly: undoing a removal means calling
    // createRole, so if createRole is what failed, the undo fails too and the
    // user is left holding no role at all. Granting first means a failure here
    // has nothing to undo, and the roles they already had are still intact.
    if (wanted.length === 0) {
      const row = await store.createRole({ userId, organizationId: organization.id, role })
      record(`role ${role}`, () => store.deleteRole(row.id))
      actions.push({ kind: 'role', change: 'created', detail: role })
    } else {
      actions.push({ kind: 'role', change: 'unchanged', detail: role })
    }

    for (const stale of surplus) {
      await store.deleteRole(stale.id)
      record(`role ${stale.role}`, () =>
        store.createRole({ userId, organizationId: organization.id, role: stale.role }),
      )
      actions.push({ kind: 'role', change: 'removed', detail: stale.role })
    }

    return {
      email,
      dryRun: false,
      userId,
      adopted,
      organization,
      program,
      role,
      identities: existing?.identities ?? [],
      hasPassword: Boolean(existing?.hasPassword),
      actions,
      warnings,
    }
  } catch (error) {
    // Unwind in reverse. A partial account is the dangerous outcome: the person
    // would be refused at the door while the dashboard suggested otherwise.
    const undoFailures = []
    for (const step of [...created].reverse()) {
      try {
        await step.undo()
      } catch (undoError) {
        undoFailures.push(`${step.what}: ${undoError.message}`)
      }
    }
    error.rolledBack = created.map((step) => step.what)
    error.undoFailures = undoFailures
    throw error
  }
}
