#!/usr/bin/env node
/**
 * Provisions one authorized OpeniWatch user.
 *
 * SERVER-SIDE ONLY. This uses the Supabase secret key, which bypasses Row Level
 * Security entirely. It must never run in a browser, never be bundled by Vite,
 * and never have its key placed in a Netlify environment variable.
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
 * Deliberate overrides, each of which relaxes a refusal and says so in the
 * output: --allow-password-credential, --allow-additional-organization.
 *
 * This file is the command line. The decisions live in lib/provisionUser.mjs
 * and are covered by src/services/provisioning/provisionUser.test.ts.
 */

import { createClient } from '@supabase/supabase-js'
import { createSupabaseStore } from './lib/supabaseStore.mjs'
import { ProvisioningError, VALID_ROLES, provisionUser } from './lib/provisionUser.mjs'

/**
 * SUPABASE_SECRET_KEY holds an `sb_secret_...` value from
 * Project Settings -> API Keys. The legacy service_role JWT is not accepted:
 * falling back to it would let this script keep working after the migration
 * while still depending on a key the project is retiring.
 */
function requireSecretKey() {
  const key = process.env.SUPABASE_SECRET_KEY
  if (!key) {
    fatal(
      'SUPABASE_SECRET_KEY is not set.\n' +
        'Copy the sb_secret_... value from Project Settings -> API Keys.\n' +
        'Do not use the Legacy API keys page, and do not use a service_role JWT.',
    )
  }
  if (!/^sb_secret_/.test(key)) {
    fatal(
      'SUPABASE_SECRET_KEY does not look like a secret key.\n' +
        'Expected a value beginning sb_secret_ from Project Settings -> API Keys.',
    )
  }
  return key
}

function fatal(message) {
  console.error(message)
  process.exit(1)
}

function parseArgs(argv) {
  const flags = new Set(['dry-run', 'allow-password-credential', 'allow-additional-organization'])
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (flags.has(key)) {
      args[key] = true
      continue
    }
    const value = argv[i + 1]
    if (value === undefined || value.startsWith('--')) fatal(`Option --${key} needs a value.`)
    args[key] = value
    i += 1
  }
  return args
}

function usage(message) {
  fatal(`${message}

Usage:
  SUPABASE_URL=... SUPABASE_SECRET_KEY=... \\
  node scripts/provision-user.mjs --email <address> --name "<full name>" \\
    --role <${VALID_ROLES.join('|')}> --org <organization-slug> [--program <program-slug>]

Optional: --title "<job title>" --phone "<number>" --time-zone <IANA zone> --dry-run
Overrides: --allow-password-credential --allow-additional-organization`)
}

const args = parseArgs(process.argv.slice(2))

const SUPABASE_URL = process.env.SUPABASE_URL
if (!SUPABASE_URL) usage('SUPABASE_URL must be set in the environment.')
const SECRET_KEY = requireSecretKey()

if (!args.email) usage('--email is required.')
if (!args.name) usage('--name is required.')
if (!args.role || !VALID_ROLES.includes(args.role)) {
  usage(`--role is required and must be one of: ${VALID_ROLES.join(', ')}`)
}
if (!args.org) usage('--org is required (the organization slug).')

const client = createClient(SUPABASE_URL, SECRET_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const CHANGED = new Set(['created', 'updated', 'removed'])

try {
  const result = await provisionUser(createSupabaseStore(client), {
    email: args.email,
    fullName: args.name,
    role: args.role,
    organizationSlug: args.org,
    programSlug: args.program,
    title: args.title,
    phone: args.phone,
    timeZone: args['time-zone'],
    dryRun: Boolean(args['dry-run']),
    allowPasswordCredential: Boolean(args['allow-password-credential']),
    allowAdditionalOrganization: Boolean(args['allow-additional-organization']),
  })

  console.log(`Organization : ${result.organization.name} (${result.organization.slug})`)
  console.log(`Program      : ${result.program ? `${result.program.name} (${result.program.slug})` : '(none)'}`)
  console.log(`Email        : ${result.email}`)
  console.log(`Role         : ${result.role}`)
  if (result.identities.length > 0) {
    console.log(`Identities   : ${result.identities.join(', ')}`)
  }

  if (result.dryRun) {
    console.log(
      `\n--dry-run: nothing was written. ` +
        (result.userId ? `An auth user already exists (${result.userId}).` : 'No auth user exists yet.'),
    )
    process.exit(0)
  }

  console.log(`Auth user    : ${result.adopted ? 'adopted existing' : 'created'} ${result.userId}`)
  for (const action of result.actions) {
    if (action.kind === 'auth_user') continue
    const label = action.detail ? `${action.kind} (${action.detail})` : action.kind
    console.log(`  ${action.change.padEnd(9)} ${label}`)
  }

  for (const warning of result.warnings) console.warn(`\nWARNING: ${warning}`)

  const changed = result.actions.some((action) => CHANGED.has(action.change))
  console.log(
    changed
      ? `\nDone. ${result.email} can sign in with Microsoft or an email sign-in link.\n\n` +
          'No password was set and no invitation was sent. Tell them the site\n' +
          'address; they sign in from the normal sign-in screen.'
      : `\nAlready provisioned. Nothing changed.`,
  )
} catch (error) {
  if (error instanceof ProvisioningError) {
    console.error(`\nRefused (${error.code}):\n\n${error.message}`)
  } else {
    console.error(`\nProvisioning failed: ${error.message}`)
  }
  if (error.rolledBack?.length) {
    console.error(`\nRolled back: ${error.rolledBack.join(', ')}`)
  }
  if (error.undoFailures?.length) {
    console.error('\nCOULD NOT UNDO — remove these by hand before retrying:')
    for (const failure of error.undoFailures) console.error(`  ${failure}`)
  }
  process.exit(1)
}
