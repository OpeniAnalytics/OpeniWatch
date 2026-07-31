#!/usr/bin/env node
/**
 * Creates the six development seed users in a Supabase project.
 *
 * NO PASSWORDS ARE STORED IN THIS REPOSITORY.
 *
 * Passwords come from the environment at run time. Supply one shared
 * development password:
 *
 *   SUPABASE_URL=... \
 *   SUPABASE_SERVICE_ROLE_KEY=... \
 *   OPENIWATCH_SEED_PASSWORD='a-strong-development-password' \
 *   node scripts/seed-users.mjs
 *
 * or a distinct password per role:
 *
 *   OPENIWATCH_SEED_PASSWORD_ANALYST='...' node scripts/seed-users.mjs
 *
 * NEVER run this against a production project. It refuses to run without an
 * explicit --allow-production flag when the URL does not look like a local or
 * development instance.
 */

import { createClient } from '@supabase/supabase-js'

const ORG_ID = 'a0000000-0000-4000-8000-000000000001'
const PROGRAM_ID = 'a0000000-0000-4000-8000-000000000002'

/** Mirrors src/data/seed/users.ts. Keep the two in step. */
const SEED_USERS = [
  {
    userId: '10000000-0000-4000-8000-000000000001',
    email: 'super.admin@openiwatch.example',
    fullName: 'Avery Sloan',
    title: 'Platform administrator',
    role: 'super_admin',
    timeZone: 'America/Chicago',
  },
  {
    userId: '10000000-0000-4000-8000-000000000002',
    email: 'program.admin@openiwatch.example',
    fullName: 'Dana Whitfield',
    title: 'Program administrator',
    role: 'program_admin',
    timeZone: 'America/Chicago',
  },
  {
    userId: '10000000-0000-4000-8000-000000000003',
    email: 'analyst@openiwatch.example',
    fullName: 'Rowan Estrada',
    title: 'Intelligence analyst',
    role: 'analyst',
    timeZone: 'America/Chicago',
  },
  {
    userId: '10000000-0000-4000-8000-000000000004',
    email: 'soc.manager@openiwatch.example',
    fullName: 'Kai Brennan',
    title: 'SOC manager',
    role: 'soc_manager',
    timeZone: 'America/Chicago',
  },
  {
    userId: '10000000-0000-4000-8000-000000000005',
    email: 'soc.operator@openiwatch.example',
    fullName: 'Jordan Reyes',
    title: 'SOC operator',
    role: 'soc_operator',
    timeZone: 'America/New_York',
  },
  {
    userId: '10000000-0000-4000-8000-000000000006',
    email: 'viewer@openiwatch.example',
    fullName: 'Sam Okonkwo',
    title: 'Client stakeholder',
    role: 'viewer',
    timeZone: 'America/New_York',
  },
]

const url = process.env.SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const allowProduction = process.argv.includes('--allow-production')

if (!url || !serviceRoleKey) {
  console.error(
    'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.\n' +
      'Find them in your Supabase project settings, or run `supabase status` for a local stack.',
  )
  process.exit(1)
}

const looksLocal = /localhost|127\.0\.0\.1|\.local/.test(url)
if (!looksLocal && !allowProduction) {
  console.error(
    `Refusing to seed users into ${url}: it does not look like a local instance.\n` +
      'These are development accounts. If you are certain, re-run with --allow-production.',
  )
  process.exit(1)
}

function passwordFor(user) {
  const specific = process.env[`OPENIWATCH_SEED_PASSWORD_${user.role.toUpperCase()}`]
  const shared = process.env.OPENIWATCH_SEED_PASSWORD
  const password = specific || shared
  if (!password) {
    console.error(
      'No password supplied. Set OPENIWATCH_SEED_PASSWORD, or a per-role\n' +
        'OPENIWATCH_SEED_PASSWORD_<ROLE> variable. Passwords are never stored in this repository.',
    )
    process.exit(1)
  }
  if (password.length < 12) {
    console.error('Seed passwords must be at least 12 characters.')
    process.exit(1)
  }
  return password
}

const supabase = createClient(url, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

async function upsertUser(user) {
  const password = passwordFor(user)

  // createUser fails if the id already exists, which makes the script safe to
  // re-run: an existing account is updated rather than duplicated.
  const { data: created, error: createError } = await supabase.auth.admin.createUser({
    // Fixing the id keeps auth.users aligned with the seeded profiles.
    id: user.userId,
    email: user.email,
    password,
    email_confirm: true,
    user_metadata: { full_name: user.fullName },
  })

  if (createError && !/already been registered|already exists/i.test(createError.message)) {
    throw new Error(`${user.email}: ${createError.message}`)
  }

  if (createError) {
    const { error: updateError } = await supabase.auth.admin.updateUserById(user.userId, {
      password,
      email: user.email,
    })
    if (updateError) throw new Error(`${user.email}: ${updateError.message}`)
    console.log(`  updated  ${user.email.padEnd(38)} ${user.role}`)
  } else {
    console.log(`  created  ${user.email.padEnd(38)} ${user.role} (${created.user.id})`)
  }

  const { error: profileError } = await supabase.from('profiles').upsert(
    {
      user_id: user.userId,
      email: user.email,
      full_name: user.fullName,
      title: user.title,
      time_zone: user.timeZone,
      is_active: true,
    },
    { onConflict: 'user_id' },
  )
  if (profileError) throw new Error(`${user.email} profile: ${profileError.message}`)

  const { error: membershipError } = await supabase.from('organization_memberships').upsert(
    { organization_id: ORG_ID, user_id: user.userId, is_primary: true },
    { onConflict: 'organization_id,user_id' },
  )
  if (membershipError) throw new Error(`${user.email} membership: ${membershipError.message}`)

  const { error: programError } = await supabase.from('program_memberships').upsert(
    { program_id: PROGRAM_ID, user_id: user.userId },
    { onConflict: 'program_id,user_id' },
  )
  if (programError) throw new Error(`${user.email} program membership: ${programError.message}`)

  // The super administrator is platform-wide; everyone else is org-scoped.
  const { error: roleError } = await supabase.from('user_roles').upsert(
    {
      user_id: user.userId,
      role: user.role,
      organization_id: user.role === 'super_admin' ? null : ORG_ID,
      program_id: null,
    },
    { onConflict: 'user_id,role,organization_id,program_id' },
  )
  if (roleError && !/duplicate key/i.test(roleError.message)) {
    throw new Error(`${user.email} role: ${roleError.message}`)
  }
}

async function main() {
  console.log(`Seeding ${SEED_USERS.length} development users into ${url}\n`)
  for (const user of SEED_USERS) {
    await upsertUser(user)
  }
  console.log(
    '\nDone. These are development accounts with environment-supplied passwords.\n' +
      'Rotate or remove them before any production use.',
  )
}

main().catch((error) => {
  console.error(`\nSeeding failed: ${error.message}`)
  process.exit(1)
})
