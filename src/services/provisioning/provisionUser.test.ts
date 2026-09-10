import { beforeEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error -- plain ESM, deliberately not TypeScript: the script must
// run under bare `node` with no build step, on a machine holding the secret key.
import { ProvisioningError, normalizeEmail, provisionUser } from '../../../scripts/lib/provisionUser.mjs'

/**
 * Provisioning is the point where authentication becomes authorization, so the
 * rules it enforces are a security boundary and deserve real tests.
 *
 * The store is in-memory rather than mocked call-by-call. Asserting "createUser
 * was called once" proves the shape of a call; asserting that two runs leave
 * exactly one auth user, one membership and one role proves the property that
 * actually matters.
 */

interface Row { [key: string]: unknown }

function createMemoryStore(seed: {
  organizations?: Row[]
  programs?: Row[]
  authUsers?: Row[]
  profiles?: Row[]
  organizationMemberships?: Row[]
  programMemberships?: Row[]
  roles?: Row[]
} = {}) {
  let nextId = 1
  const id = (prefix: string) => `${prefix}-${nextId++}`

  const db = {
    organizations: seed.organizations ?? [{ id: 'org-1', name: 'Openi Security', slug: 'openi-security-services' }],
    programs: seed.programs ?? [{ id: 'prog-1', name: 'Costco Pilot', slug: 'costco-pilot', organizationId: 'org-1' }],
    authUsers: seed.authUsers ?? [],
    profiles: seed.profiles ?? [],
    organizationMemberships: seed.organizationMemberships ?? [],
    programMemberships: seed.programMemberships ?? [],
    roles: seed.roles ?? [],
  }

  /** Steps the caller wants to blow up, to exercise rollback. */
  const failures = new Map<string, string>()

  const store = {
    db,
    failures,
    failOn(step: string, message = 'injected failure') {
      failures.set(step, message)
    },
    guard(step: string) {
      const message = failures.get(step)
      if (message) throw new Error(message)
    },

    async findOrganizationBySlug(slug: string) {
      return db.organizations.find((o) => o.slug === slug) ?? null
    },
    async findProgramBySlug(slug: string) {
      return db.programs.find((p) => p.slug === slug) ?? null
    },
    async findAuthUserByEmail(email: string) {
      return db.authUsers.find((u) => u.email === email) ?? null
    },
    async createAuthUserWithoutPassword({ email, fullName }: { email: string; fullName: string }) {
      store.guard('createAuthUser')
      const user = { id: id('user'), email, fullName, hasPassword: false, identities: [] as string[] }
      db.authUsers.push(user)
      return user
    },
    async deleteAuthUser(userId: string) {
      store.guard('deleteAuthUser')
      db.authUsers = db.authUsers.filter((u) => u.id !== userId)
    },

    async findProfileByUserId(userId: string) {
      return db.profiles.find((p) => p.userId === userId) ?? null
    },
    async createProfile(profile: Row) {
      store.guard('createProfile')
      db.profiles.push({ id: id('profile'), ...profile })
    },
    async updateProfile(userId: string, patch: Row) {
      store.guard('updateProfile')
      const profile = db.profiles.find((p) => p.userId === userId)
      if (profile) Object.assign(profile, patch)
    },
    async deleteProfile(userId: string) {
      db.profiles = db.profiles.filter((p) => p.userId !== userId)
    },

    async listOrganizationMemberships(userId: string) {
      return db.organizationMemberships.filter((m) => m.userId === userId)
    },
    async createOrganizationMembership(membership: Row) {
      store.guard('createOrganizationMembership')
      db.organizationMemberships.push({ id: id('member'), ...membership })
    },
    async deleteOrganizationMembership(organizationId: string, userId: string) {
      db.organizationMemberships = db.organizationMemberships.filter(
        (m) => !(m.organizationId === organizationId && m.userId === userId),
      )
    },

    async listProgramMemberships(userId: string) {
      return db.programMemberships.filter((m) => m.userId === userId)
    },
    async createProgramMembership(membership: Row) {
      store.guard('createProgramMembership')
      db.programMemberships.push({ id: id('progmember'), ...membership })
    },
    async deleteProgramMembership(programId: string, userId: string) {
      db.programMemberships = db.programMemberships.filter(
        (m) => !(m.programId === programId && m.userId === userId),
      )
    },

    async listRoles(userId: string, organizationId: string) {
      return db.roles.filter((r) => r.userId === userId && r.organizationId === organizationId)
    },
    async createRole(role: Row) {
      store.guard('createRole')
      const row = { id: id('role'), ...role }
      db.roles.push(row)
      return row
    },
    async deleteRole(roleId: string) {
      db.roles = db.roles.filter((r) => r.id !== roleId)
    },
  }

  return store
}

const BASE = {
  email: 'casey@example.com',
  fullName: 'Casey Rivera',
  role: 'soc_manager',
  organizationSlug: 'openi-security-services',
  programSlug: 'costco-pilot',
}

describe('normalizeEmail', () => {
  it('lowercases and trims, so one person cannot become two accounts', () => {
    expect(normalizeEmail('  Casey@Example.COM ')).toBe('casey@example.com')
  })

  it.each(['', 'not-an-address', 'casey@', '@example.com', 'casey example.com'])(
    'rejects %j',
    (value) => {
      expect(() => normalizeEmail(value)).toThrow(ProvisioningError)
    },
  )
})

describe('a new user', () => {
  let store: ReturnType<typeof createMemoryStore>
  beforeEach(() => {
    store = createMemoryStore()
  })

  it('is created without a password', async () => {
    const result = await provisionUser(store, BASE)

    expect(result.adopted).toBe(false)
    expect(store.db.authUsers).toHaveLength(1)
    // The property that matters: nothing anywhere set a password.
    expect(store.db.authUsers[0]).not.toHaveProperty('password')
    expect(store.db.authUsers[0]!.hasPassword).toBe(false)
  })

  it('gets a profile, both memberships and exactly one role', async () => {
    await provisionUser(store, BASE)

    expect(store.db.profiles).toHaveLength(1)
    expect(store.db.profiles[0]!.isActive).toBe(true)
    expect(store.db.organizationMemberships).toHaveLength(1)
    expect(store.db.programMemberships).toHaveLength(1)
    expect(store.db.roles).toHaveLength(1)
    expect(store.db.roles[0]!.role).toBe('soc_manager')
  })

  it('is the primary organization when it is their first', async () => {
    await provisionUser(store, BASE)
    expect(store.db.organizationMemberships[0]!.isPrimary).toBe(true)
  })

  it('writes nothing at all on --dry-run', async () => {
    const result = await provisionUser(store, { ...BASE, dryRun: true })

    expect(result.dryRun).toBe(true)
    expect(store.db.authUsers).toEqual([])
    expect(store.db.profiles).toEqual([])
    expect(store.db.organizationMemberships).toEqual([])
    expect(store.db.roles).toEqual([])
  })
})

describe('an existing Microsoft user', () => {
  let store: ReturnType<typeof createMemoryStore>
  beforeEach(() => {
    store = createMemoryStore({
      authUsers: [
        {
          id: 'user-existing',
          email: 'casey@example.com',
          hasPassword: false,
          identities: ['email', 'azure'],
        },
      ],
    })
  })

  it('is adopted rather than duplicated', async () => {
    const result = await provisionUser(store, BASE)

    expect(result.adopted).toBe(true)
    expect(result.userId).toBe('user-existing')
    expect(store.db.authUsers).toHaveLength(1)
  })

  it('keeps its Azure identity untouched', async () => {
    await provisionUser(store, BASE)
    expect(store.db.authUsers[0]!.identities).toEqual(['email', 'azure'])
  })

  it('is matched case-insensitively, so no second account appears', async () => {
    await provisionUser(store, { ...BASE, email: 'CASEY@Example.com' })
    expect(store.db.authUsers).toHaveLength(1)
    expect(store.db.authUsers[0]!.id).toBe('user-existing')
  })

  it('never has a password set for it', async () => {
    await provisionUser(store, BASE)
    expect(store.db.authUsers[0]!.hasPassword).toBe(false)
    expect(store.db.authUsers[0]).not.toHaveProperty('password')
  })
})

describe('an account carrying a password credential', () => {
  const seed = () =>
    createMemoryStore({
      authUsers: [
        { id: 'user-pw', email: 'casey@example.com', hasPassword: true, identities: ['email', 'azure'] },
      ],
    })

  it('is refused authorization', async () => {
    const store = seed()
    await expect(provisionUser(store, BASE)).rejects.toMatchObject({
      code: 'password_credential_present',
    })
  })

  it('is granted nothing at all by the refused run', async () => {
    const store = seed()
    await provisionUser(store, BASE).catch(() => undefined)

    // The whole point: a refusal must not leave a half-authorized account.
    expect(store.db.profiles).toEqual([])
    expect(store.db.organizationMemberships).toEqual([])
    expect(store.db.programMemberships).toEqual([])
    expect(store.db.roles).toEqual([])
  })

  it('proceeds only with the explicit override, and says so', async () => {
    const store = seed()
    const result = await provisionUser(store, { ...BASE, allowPasswordCredential: true })

    expect(store.db.organizationMemberships).toHaveLength(1)
    expect(result.warnings.join(' ')).toMatch(/password credential/i)
  })

  it('is still refused on --dry-run, so the report cannot look clean', async () => {
    const store = seed()
    await expect(provisionUser(store, { ...BASE, dryRun: true })).rejects.toMatchObject({
      code: 'password_credential_present',
    })
  })
})

describe('repeated provisioning', () => {
  it('is idempotent: a second run changes nothing', async () => {
    const store = createMemoryStore()
    await provisionUser(store, BASE)
    const snapshot = JSON.stringify(store.db)

    const second = await provisionUser(store, BASE)

    expect(JSON.stringify(store.db)).toBe(snapshot)
    expect(second.actions.every((a: { change: string }) => a.change === 'unchanged' || a.change === 'adopted')).toBe(true)
  })

  it('reports the second run as adopted, not created', async () => {
    const store = createMemoryStore()
    await provisionUser(store, BASE)
    const second = await provisionUser(store, BASE)
    expect(second.adopted).toBe(true)
  })
})

describe('partial existing state', () => {
  it('completes a profile that exists without any membership', async () => {
    const store = createMemoryStore({
      authUsers: [{ id: 'user-1', email: 'casey@example.com', hasPassword: false, identities: ['azure'] }],
      profiles: [{ id: 'p1', userId: 'user-1', email: 'casey@example.com', fullName: 'Casey Rivera', isActive: true }],
    })

    await provisionUser(store, BASE)

    expect(store.db.profiles).toHaveLength(1)
    expect(store.db.organizationMemberships).toHaveLength(1)
    expect(store.db.roles).toHaveLength(1)
  })

  it('reactivates a deactivated profile, because a leaver is recorded that way', async () => {
    const store = createMemoryStore({
      authUsers: [{ id: 'user-1', email: 'casey@example.com', hasPassword: false, identities: [] }],
      profiles: [{ id: 'p1', userId: 'user-1', email: 'casey@example.com', fullName: 'Casey Rivera', isActive: false }],
    })

    const result = await provisionUser(store, BASE)

    expect(store.db.profiles[0]!.isActive).toBe(true)
    expect(result.actions).toContainEqual(
      expect.objectContaining({ kind: 'profile', change: 'updated' }),
    )
  })

  it('adds the program membership when only the organization one exists', async () => {
    const store = createMemoryStore({
      authUsers: [{ id: 'user-1', email: 'casey@example.com', hasPassword: false, identities: [] }],
      organizationMemberships: [{ id: 'm1', organizationId: 'org-1', userId: 'user-1', isPrimary: true }],
    })

    await provisionUser(store, BASE)

    expect(store.db.organizationMemberships).toHaveLength(1)
    expect(store.db.programMemberships).toHaveLength(1)
  })
})

describe('conflicting role', () => {
  it('leaves exactly the intended role, removing the others', async () => {
    const store = createMemoryStore({
      authUsers: [{ id: 'user-1', email: 'casey@example.com', hasPassword: false, identities: [] }],
      roles: [
        { id: 'r1', userId: 'user-1', organizationId: 'org-1', role: 'viewer' },
        { id: 'r2', userId: 'user-1', organizationId: 'org-1', role: 'analyst' },
      ],
    })

    const result = await provisionUser(store, BASE)

    expect(store.db.roles).toHaveLength(1)
    expect(store.db.roles[0]!.role).toBe('soc_manager')
    expect(result.actions.filter((a: { change: string }) => a.change === 'removed')).toHaveLength(2)
  })

  it('does not touch roles the user holds in a different organization', async () => {
    const store = createMemoryStore({
      organizations: [
        { id: 'org-1', name: 'Openi Security', slug: 'openi-security-services' },
        { id: 'org-2', name: 'Other Tenant', slug: 'other-tenant' },
      ],
      authUsers: [{ id: 'user-1', email: 'casey@example.com', hasPassword: false, identities: [] }],
      organizationMemberships: [{ id: 'm1', organizationId: 'org-1', userId: 'user-1', isPrimary: true }],
      roles: [{ id: 'r-other', userId: 'user-1', organizationId: 'org-2', role: 'viewer' }],
    })

    await provisionUser(store, BASE)

    expect(store.db.roles.find((r) => r.id === 'r-other')).toBeDefined()
  })
})

describe('wrong organization', () => {
  it('refuses to widen access across tenants without an explicit flag', async () => {
    const store = createMemoryStore({
      organizations: [
        { id: 'org-1', name: 'Openi Security', slug: 'openi-security-services' },
        { id: 'org-2', name: 'Other Tenant', slug: 'other-tenant' },
      ],
      authUsers: [{ id: 'user-1', email: 'casey@example.com', hasPassword: false, identities: [] }],
      organizationMemberships: [{ id: 'm1', organizationId: 'org-2', userId: 'user-1', isPrimary: true }],
    })

    await expect(provisionUser(store, BASE)).rejects.toMatchObject({
      code: 'existing_other_organization',
    })
    expect(store.db.organizationMemberships).toHaveLength(1)
  })

  it('proceeds when the operator says the second tenant is intended', async () => {
    const store = createMemoryStore({
      organizations: [
        { id: 'org-1', name: 'Openi Security', slug: 'openi-security-services' },
        { id: 'org-2', name: 'Other Tenant', slug: 'other-tenant' },
      ],
      authUsers: [{ id: 'user-1', email: 'casey@example.com', hasPassword: false, identities: [] }],
      organizationMemberships: [{ id: 'm1', organizationId: 'org-2', userId: 'user-1', isPrimary: true }],
    })

    await provisionUser(store, { ...BASE, allowAdditionalOrganization: true })
    expect(store.db.organizationMemberships).toHaveLength(2)
  })

  it('refuses a program belonging to a different organization', async () => {
    const store = createMemoryStore({
      programs: [{ id: 'prog-x', name: 'Foreign', slug: 'foreign', organizationId: 'org-999' }],
    })

    await expect(
      provisionUser(store, { ...BASE, programSlug: 'foreign' }),
    ).rejects.toMatchObject({ code: 'program_wrong_organization' })
  })

  it('refuses an unknown organization slug', async () => {
    const store = createMemoryStore()
    await expect(
      provisionUser(store, { ...BASE, organizationSlug: 'does-not-exist' }),
    ).rejects.toMatchObject({ code: 'organization_not_found' })
  })
})

describe('rollback', () => {
  it('deletes the auth user it created when a later step fails', async () => {
    const store = createMemoryStore()
    store.failOn('createOrganizationMembership')

    await expect(provisionUser(store, BASE)).rejects.toThrow('injected failure')

    // A partial account is the dangerous outcome: refused at the door while the
    // dashboard suggests access was granted.
    expect(store.db.authUsers).toEqual([])
    expect(store.db.profiles).toEqual([])
  })

  it('leaves rows that existed before the run alone', async () => {
    const store = createMemoryStore({
      authUsers: [{ id: 'user-1', email: 'casey@example.com', hasPassword: false, identities: ['azure'] }],
      profiles: [{ id: 'p1', userId: 'user-1', email: 'casey@example.com', fullName: 'Casey Rivera', isActive: true }],
    })
    store.failOn('createRole')

    await expect(provisionUser(store, BASE)).rejects.toThrow('injected failure')

    // Adopted, not created — so rollback must not delete them.
    expect(store.db.authUsers).toHaveLength(1)
    expect(store.db.profiles).toHaveLength(1)
    expect(store.db.organizationMemberships).toEqual([])
  })

  it('restores a role it removed before the failure', async () => {
    const store = createMemoryStore({
      authUsers: [{ id: 'user-1', email: 'casey@example.com', hasPassword: false, identities: [] }],
      profiles: [{ id: 'p1', userId: 'user-1', email: 'casey@example.com', fullName: 'Casey Rivera', isActive: true }],
      organizationMemberships: [{ id: 'm1', organizationId: 'org-1', userId: 'user-1', isPrimary: true }],
      programMemberships: [{ id: 'pm1', programId: 'prog-1', userId: 'user-1' }],
      roles: [
        { id: 'r1', userId: 'user-1', organizationId: 'org-1', role: 'viewer' },
        { id: 'r2', userId: 'user-1', organizationId: 'org-1', role: 'analyst' },
      ],
    })
    // Fail while removing the second surplus role, after the first is gone.
    let removals = 0
    const realDelete = store.deleteRole.bind(store)
    store.deleteRole = async (roleId: string) => {
      removals += 1
      if (removals === 2) throw new Error('injected failure')
      return realDelete(roleId)
    }

    await expect(provisionUser(store, BASE)).rejects.toThrow('injected failure')

    // The first removal is put back, and the newly granted role is withdrawn:
    // the user ends where they started, holding both original roles.
    expect(store.db.roles.map((r) => r.role).sort()).toEqual(['analyst', 'viewer'])
  })

  it('leaves the existing roles alone when granting the new one fails', async () => {
    const store = createMemoryStore({
      authUsers: [{ id: 'user-1', email: 'casey@example.com', hasPassword: false, identities: [] }],
      profiles: [{ id: 'p1', userId: 'user-1', email: 'casey@example.com', fullName: 'Casey Rivera', isActive: true }],
      organizationMemberships: [{ id: 'm1', organizationId: 'org-1', userId: 'user-1', isPrimary: true }],
      programMemberships: [{ id: 'pm1', programId: 'prog-1', userId: 'user-1' }],
      roles: [{ id: 'r1', userId: 'user-1', organizationId: 'org-1', role: 'viewer' }],
    })
    store.failOn('createRole')

    await expect(provisionUser(store, BASE)).rejects.toThrow('injected failure')

    // Granting happens before revoking precisely so this case leaves the user
    // with the role they had, rather than with none.
    expect(store.db.roles).toHaveLength(1)
    expect(store.db.roles[0]!.role).toBe('viewer')
  })

  it('reports what it could not undo rather than staying quiet', async () => {
    const store = createMemoryStore()
    store.failOn('createProfile')
    store.failOn('deleteAuthUser')

    const error = await provisionUser(store, BASE).catch((e: Error) => e)

    expect((error as { undoFailures?: string[] }).undoFailures?.join(' ')).toMatch(/auth user/)
  })
})

describe('an existing Auth identity is never authorization', () => {
  it('grants nothing merely because the auth user exists', async () => {
    const store = createMemoryStore({
      authUsers: [{ id: 'user-1', email: 'casey@example.com', hasPassword: false, identities: ['azure'] }],
    })

    // Before provisioning: authenticated, but authorized for nothing.
    expect(store.db.profiles).toEqual([])
    expect(store.db.organizationMemberships).toEqual([])
    expect(store.db.roles).toEqual([])

    // Every grant below is written deliberately by this run, never inferred.
    const result = await provisionUser(store, BASE)
    expect(result.actions.filter((a: { change: string }) => a.change === 'created')).toHaveLength(4)
  })

  it('refuses an invalid role rather than defaulting to one', async () => {
    const store = createMemoryStore()
    await expect(provisionUser(store, { ...BASE, role: 'root' })).rejects.toMatchObject({
      code: 'role_invalid',
    })
    expect(store.db.roles).toEqual([])
  })

  it('requires a name, so a profile is never created blank', async () => {
    const store = createMemoryStore()
    await expect(provisionUser(store, { ...BASE, fullName: '   ' })).rejects.toMatchObject({
      code: 'name_required',
    })
  })
})

describe('the script never supplies a password', () => {
  it('passes no password field to the store, on any path', async () => {
    const store = createMemoryStore()
    const spy = vi.spyOn(store, 'createAuthUserWithoutPassword')

    await provisionUser(store, BASE)

    expect(spy).toHaveBeenCalledTimes(1)
    const [payload] = spy.mock.calls[0] as [Record<string, unknown>]
    expect(Object.keys(payload).sort()).toEqual(['email', 'fullName'])
  })

  it('exposes no way to set one through options', async () => {
    const store = createMemoryStore()
    // Even if a caller tries, it must not reach the store.
    await provisionUser(store, { ...BASE, password: 'hunter2-hunter2' } as never)
    expect(store.db.authUsers[0]).not.toHaveProperty('password')
    expect(store.db.authUsers[0]!.hasPassword).toBe(false)
  })
})
