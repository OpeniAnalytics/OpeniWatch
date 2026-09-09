#!/usr/bin/env node
/**
 * Provisions one authorized OpeniWatch user.
 *
 * SERVER-SIDE ONLY. This uses the Supabase secret key, which bypasses
 * Row Level Security entirely. It must never run in a browser, never be bundled
 * by Vite, and never have its key placed in a Netlify environment variable.
 *
 *   SUPABASE_URL=https://<ref>.supabase.co \
 *   SUPABASE_SECRET_KEY=<sb_secret_...> \
 *   node scripts/provision-user.mjs \
 *     --email person@company.com \
 *     --name "Casey Rivera" \
 *     --role soc_manager \
 *     --org openi-security-services \
 *     --program costco-pilot
 *
 * Optional: --title, --phone, --time-zone, --dry-run.
 *
 * ---------------------------------------------------------------------------
 * No password, and no invitation
 * ---------------------------------------------------------------------------
 *
 * The account is created with `email_confirm: true` and NO password, which is
 * what makes it usable with Microsoft sign-in and with magic links while being
 * unusable with a password — there is nothing to guess, phish or reuse.
 *
 * `createUser` is used rather than `inviteUserByEmail` deliberately: an invite
 * sends mail on Supabase's schedule with Supabase's wording, at a moment the
 * administrator did not choose. Provisioning and telling someone about it are
 * separate acts. The operator signs in whenever they like, through the normal
 * sign-in screen.
 *
 * ---------------------------------------------------------------------------
 * All-or-nothing
 * ---------------------------------------------------------------------------
 *
 * A user spread across auth.users, profiles, organization_memberships,
 * program_memberships and user_roles is only useful if every part exists. The
 * PostgREST API cannot wrap those in one transaction, so this script records
 * every row it creates and unwinds them in reverse on any failure.
 *
 * A partially provisioned account is the dangerous outcome: an auth user with
 * no membership can sign in and see the "Access not authorized" screen — that
 * part is safe — but an administrator reading the dashboard would believe the
 * person had been granted access when they had not.
 */

import { createClient } from '@supabase/supabase-js'

/**
 * Supabase credential.
 *
 * SUPABASE_SECRET_KEY holds an `sb_secret_...` value from
 * Project Settings -> API Keys. It bypasses Row Level Security completely, so
 * it belongs only in a server-side shell: never in a VITE_ variable, never in
 * a Netlify build environment, never in source control.
 *
 * The legacy `service_role` JWT is not accepted. Falling back to it would let
 * this script keep working after the migration while still depending on a key
 * the project is retiring.
 */
function requireSecretKey() {
  const key = process.env.SUPABASE_SECRET_KEY
  if (!key) {
    console.error(
      'SUPABASE_SECRET_KEY is not set.\n' +
        'Copy the sb_secret_... value from Project Settings -> API Keys.\n' +
        'Do not use the Legacy API keys page, and do not use a service_role JWT.',
    )
    process.exit(1)
  }
  if (!/^sb_secret_/.test(key)) {
    console.error(
      'SUPABASE_SECRET_KEY does not look like a secret key.\n' +
        'Expected a value beginning sb_secret_ from Project Settings -> API Keys.',
    )
    process.exit(1)
  }
  return key
}


const VALID_ROLES = [
  'super_admin',
  'program_admin',
  'analyst',
  'soc_manager',
  'soc_operator',
  'viewer',
]

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key === 'dry-run') {
      args.dryRun = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) {
      console.error(`Option --${key} needs a value.`)
      process.exit(1)
    }
    args[key] = value
    i += 1
  }
  return args
}

function usage(message) {
  console.error(`${message}

Usage:
  SUPABASE_URL=... SUPABASE_SECRET_KEY=... \\
  node scripts/provision-user.mjs --email <address> --name "<full name>" \\
    --role <${VALID_ROLES.join('|')}> --org <organization-slug> [--program <program-slug>]

Optional: --title "<job title>" --phone "<number>" --time-zone <IANA zone> --dry-run`)
  process.exit(1)
}

const args = parseArgs(process.argv.slice(2))

const SUPABASE_URL = process.env.SUPABASE_URL
const SECRET_KEY = requireSecretKey()

if (!SUPABASE_URL || !SECRET_KEY) {
  usage('SUPABASE_URL and SUPABASE_SECRET_KEY must both be set in the environment.')
}
if (!args.email || !args.email.includes('@')) usage('--email is required and must be an address.')
if (!args.name) usage('--name is required.')
if (!args.role || !VALID_ROLES.includes(args.role)) {
  usage(`--role is required and must be one of: ${VALID_ROLES.join(', ')}`)
}
if (!args.org) usage('--org is required (the organization slug).')

const email = args.email.trim().toLowerCase()
const dryRun = Boolean(args.dryRun)

const supabase = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/** Rows created by this run, unwound in reverse if anything fails. */
const created = []

async function rollback() {
  if (created.length === 0) return
  console.error('\nRolling back partial provisioning…')
  for (const step of [...created].reverse()) {
    try {
      await step.undo()
      console.error(`  undone: ${step.what}`)
    } catch (error) {
      // Report and keep going: one failed undo must not strand the rest.
      console.error(`  COULD NOT UNDO ${step.what}: ${error.message}`)
      console.error('  Remove it by hand before retrying.')
    }
  }
}

async function fail(message) {
  console.error(`\nProvisioning failed: ${message}`)
  await rollback()
  process.exit(1)
}

async function main() {
  // ---- Resolve the organization and program by slug ------------------------
  const { data: org, error: orgError } = await supabase
    .from('organizations')
    .select('id, name, slug')
    .eq('slug', args.org)
    .maybeSingle()
  if (orgError) await fail(`could not read organizations: ${orgError.message}`)
  if (!org) await fail(`no organization with slug "${args.org}".`)

  let program = null
  if (args.program) {
    const { data, error } = await supabase
      .from('programs')
      .select('id, name, slug, organization_id')
      .eq('slug', args.program)
      .maybeSingle()
    if (error) await fail(`could not read programs: ${error.message}`)
    if (!data) await fail(`no program with slug "${args.program}".`)
    if (data.organization_id !== org.id) {
      await fail(`program "${args.program}" does not belong to organization "${args.org}".`)
    }
    program = data
  }

  console.log(`Organization : ${org.name} (${org.slug})`)
  console.log(`Program      : ${program ? `${program.name} (${program.slug})` : '(none)'}`)
  console.log(`Email        : ${email}`)
  console.log(`Name         : ${args.name}`)
  console.log(`Role         : ${args.role}`)

  if (dryRun) {
    console.log('\n--dry-run: nothing was written.')
    return
  }

  // ---- Auth user -----------------------------------------------------------
  // An existing account is reused rather than duplicated, so re-running after a
  // failure is safe.
  let userId = null
  const { data: createdUser, error: createError } = await supabase.auth.admin.createUser({
    email,
    // Confirmed on creation: the operator authenticates with Microsoft or a
    // magic link, so there is no confirmation step for them to complete.
    email_confirm: true,
    // No password field at all. The account cannot be signed into with one.
    user_metadata: { full_name: args.name },
  })

  if (createError) {
    const existing = await findUserByEmail(email)
    if (!existing) await fail(`could not create the auth user: ${createError.message}`)
    userId = existing.id
    console.log(`\nAuth user    : reusing existing ${userId}`)
  } else {
    userId = createdUser.user.id
    created.push({
      what: `auth user ${userId}`,
      undo: () => supabase.auth.admin.deleteUser(userId),
    })
    console.log(`\nAuth user    : created ${userId}`)
  }

  // ---- Profile -------------------------------------------------------------
  await upsert(
    'profiles',
    {
      user_id: userId,
      email,
      full_name: args.name,
      title: args.title ?? null,
      phone: args.phone ?? null,
      time_zone: args['time-zone'] ?? 'America/Chicago',
      is_active: true,
    },
    'user_id',
    `profile for ${userId}`,
  )

  // ---- Organization membership --------------------------------------------
  // This is the record the application checks and every RLS policy resolves
  // through. Without it the user authenticates and gets nothing.
  await upsert(
    'organization_memberships',
    { organization_id: org.id, user_id: userId, is_primary: true },
    'organization_id,user_id',
    `organization membership in ${org.slug}`,
  )

  // ---- Program membership --------------------------------------------------
  if (program) {
    await upsert(
      'program_memberships',
      { program_id: program.id, user_id: userId },
      'program_id,user_id',
      `program membership in ${program.slug}`,
    )
  }

  // ---- Role ----------------------------------------------------------------
  await upsert(
    'user_roles',
    { user_id: userId, organization_id: org.id, role: args.role },
    'user_id,organization_id,role',
    `role ${args.role}`,
  )

  console.log(`
Done. ${email} can now sign in with Microsoft or an email sign-in link.

No password was set, and no invitation email was sent. Tell them the site
address; they sign in from the normal sign-in screen.`)
}

/** Inserts or updates one row, recording how to undo it. */
async function upsert(table, row, conflictColumns, description) {
  // Was it already there before this run? If so, leave it alone on rollback.
  const filter = {}
  for (const column of conflictColumns.split(',')) filter[column] = row[column]
  let existing = supabase.from(table).select('id')
  for (const [column, value] of Object.entries(filter)) existing = existing.eq(column, value)
  const { data: before } = await existing.maybeSingle()

  const { error } = await supabase.from(table).upsert(row, { onConflict: conflictColumns })
  if (error) await fail(`could not write ${description}: ${error.message}`)

  if (!before) {
    created.push({
      what: description,
      undo: async () => {
        let query = supabase.from(table).delete()
        for (const [column, value] of Object.entries(filter)) query = query.eq(column, value)
        const { error: undoError } = await query
        if (undoError) throw new Error(undoError.message)
      },
    })
    console.log(`Created      : ${description}`)
  } else {
    console.log(`Already set  : ${description}`)
  }
}

/** Finds an auth user by address, paging until found. */
async function findUserByEmail(address) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 })
    if (error) return null
    const match = data.users.find((user) => user.email?.toLowerCase() === address)
    if (match) return match
    if (data.users.length < 200) return null
  }
  return null
}

main().catch(async (error) => {
  await fail(error instanceof Error ? error.message : String(error))
})
