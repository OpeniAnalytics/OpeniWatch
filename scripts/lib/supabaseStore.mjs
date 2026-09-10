/**
 * The production adapter behind `provisionUser`.
 *
 * Everything PostgREST- and GoTrue-shaped lives here so the decisions in
 * provisionUser.mjs can be tested without a database. Each method either
 * returns plain data or throws; no method decides policy.
 */

class StoreError extends Error {
  constructor(operation, cause) {
    super(`${operation}: ${cause}`)
    this.name = 'StoreError'
  }
}

/** Unwraps a PostgREST `{ data, error }` result. */
function unwrap(operation, { data, error }) {
  if (error) throw new StoreError(operation, error.message)
  return data
}

export function createSupabaseStore(client) {
  return {
    async findOrganizationBySlug(slug) {
      const row = unwrap(
        'read organizations',
        await client.from('organizations').select('id, name, slug').eq('slug', slug).maybeSingle(),
      )
      return row ? { id: row.id, name: row.name, slug: row.slug } : null
    },

    async findProgramBySlug(slug) {
      const row = unwrap(
        'read programs',
        await client
          .from('programs')
          .select('id, name, slug, organization_id')
          .eq('slug', slug)
          .maybeSingle(),
      )
      return row
        ? { id: row.id, name: row.name, slug: row.slug, organizationId: row.organization_id }
        : null
    },

    /**
     * Finds an auth user by address.
     *
     * The Admin API has no "get by email", so this pages through listUsers.
     * Comparison is lowercased on both sides: GoTrue stores what it was given.
     */
    async findAuthUserByEmail(email) {
      for (let page = 1; page <= 50; page += 1) {
        const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 })
        if (error) throw new StoreError('list auth users', error.message)
        const match = data.users.find((user) => user.email?.trim().toLowerCase() === email)
        if (match) {
          return {
            id: match.id,
            email: match.email,
            hasPassword: await this.userHasPassword(match.id),
            identities: (match.identities ?? []).map((identity) => identity.provider),
          }
        }
        if (data.users.length < 200) return null
      }
      return null
    },

    /**
     * Whether the account carries a password credential.
     *
     * GoTrue redacts encrypted_password from every Admin API response, and
     * auth.users is not exposed through PostgREST, so this cannot be read
     * directly. Migration 0014 publishes a service_role-only function that
     * answers the boolean without exposing the hash.
     *
     * A missing function is treated as an error rather than as `false`. A check
     * that silently reports "no password" when it cannot tell would be worse
     * than no check at all: provisioning would declare the account compliant.
     */
    async userHasPassword(userId) {
      const { data, error } = await client.rpc('openiwatch_user_has_password', {
        p_user_id: userId,
      })
      if (error) {
        throw new StoreError(
          'check password credential',
          `${error.message}. Apply migration 0014_password_credential_state.sql, ` +
            'which publishes public.openiwatch_user_has_password for service_role.',
        )
      }
      return data === true
    },

    async createAuthUserWithoutPassword({ email, fullName }) {
      const { data, error } = await client.auth.admin.createUser({
        email,
        // Confirmed on creation: the operator signs in with Microsoft or a
        // magic link, so there is no confirmation step for them to complete.
        email_confirm: true,
        // No password key at all — not an empty string, which GoTrue would
        // treat as a password to hash.
        user_metadata: { full_name: fullName },
      })
      if (error) throw new StoreError('create auth user', error.message)
      return { id: data.user.id }
    },

    async deleteAuthUser(id) {
      const { error } = await client.auth.admin.deleteUser(id)
      if (error) throw new StoreError('delete auth user', error.message)
    },

    async findProfileByUserId(userId) {
      const row = unwrap(
        'read profiles',
        await client
          .from('profiles')
          .select('id, user_id, email, full_name, is_active')
          .eq('user_id', userId)
          .maybeSingle(),
      )
      return row
        ? { id: row.id, userId: row.user_id, email: row.email, fullName: row.full_name, isActive: row.is_active }
        : null
    },

    async createProfile(profile) {
      unwrap(
        'create profile',
        await client.from('profiles').insert({
          user_id: profile.userId,
          email: profile.email,
          full_name: profile.fullName,
          title: profile.title,
          phone: profile.phone,
          time_zone: profile.timeZone,
          is_active: profile.isActive,
        }),
      )
    },

    async updateProfile(userId, patch) {
      const row = {}
      if ('isActive' in patch) row.is_active = patch.isActive
      if ('fullName' in patch) row.full_name = patch.fullName
      if ('email' in patch) row.email = patch.email
      unwrap('update profile', await client.from('profiles').update(row).eq('user_id', userId))
    },

    async deleteProfile(userId) {
      unwrap('delete profile', await client.from('profiles').delete().eq('user_id', userId))
    },

    async listOrganizationMemberships(userId) {
      const rows =
        unwrap(
          'read organization memberships',
          await client
            .from('organization_memberships')
            .select('id, organization_id, user_id, is_primary')
            .eq('user_id', userId),
        ) ?? []
      return rows.map((row) => ({
        id: row.id,
        organizationId: row.organization_id,
        userId: row.user_id,
        isPrimary: row.is_primary,
      }))
    },

    async createOrganizationMembership({ organizationId, userId, isPrimary }) {
      unwrap(
        'create organization membership',
        await client
          .from('organization_memberships')
          .insert({ organization_id: organizationId, user_id: userId, is_primary: isPrimary }),
      )
    },

    async deleteOrganizationMembership(organizationId, userId) {
      unwrap(
        'delete organization membership',
        await client
          .from('organization_memberships')
          .delete()
          .eq('organization_id', organizationId)
          .eq('user_id', userId),
      )
    },

    async listProgramMemberships(userId) {
      const rows =
        unwrap(
          'read program memberships',
          await client
            .from('program_memberships')
            .select('id, program_id, user_id')
            .eq('user_id', userId),
        ) ?? []
      return rows.map((row) => ({ id: row.id, programId: row.program_id, userId: row.user_id }))
    },

    async createProgramMembership({ programId, userId }) {
      unwrap(
        'create program membership',
        await client.from('program_memberships').insert({ program_id: programId, user_id: userId }),
      )
    },

    async deleteProgramMembership(programId, userId) {
      unwrap(
        'delete program membership',
        await client
          .from('program_memberships')
          .delete()
          .eq('program_id', programId)
          .eq('user_id', userId),
      )
    },

    async listRoles(userId, organizationId) {
      const rows =
        unwrap(
          'read user roles',
          await client
            .from('user_roles')
            .select('id, user_id, organization_id, role')
            .eq('user_id', userId)
            .eq('organization_id', organizationId),
        ) ?? []
      return rows.map((row) => ({
        id: row.id,
        userId: row.user_id,
        organizationId: row.organization_id,
        role: row.role,
      }))
    },

    /**
     * Inserts a role and returns the new row.
     *
     * Deliberately an insert rather than an upsert: `user_roles_unique_scope`
     * is an expression index over coalesced organization and program ids, which
     * PostgREST's `on_conflict` cannot name. An upsert here fails at runtime.
     */
    async createRole({ userId, organizationId, role }) {
      const rows = unwrap(
        'create user role',
        await client
          .from('user_roles')
          .insert({ user_id: userId, organization_id: organizationId, role })
          .select('id, user_id, organization_id, role'),
      )
      const row = Array.isArray(rows) ? rows[0] : rows
      return {
        id: row.id,
        userId: row.user_id,
        organizationId: row.organization_id,
        role: row.role,
      }
    },

    async deleteRole(id) {
      unwrap('delete user role', await client.from('user_roles').delete().eq('id', id))
    },
  }
}
