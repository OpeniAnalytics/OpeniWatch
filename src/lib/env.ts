/**
 * Browser-visible configuration.
 *
 * Only VITE_-prefixed variables may be read here. Service-role keys, provider
 * secrets and connector API keys are read exclusively by Supabase Edge
 * Functions from the server-side environment — importing them into `src/`
 * would inline them into the browser bundle.
 *
 * The important behaviour in this file is what happens when configuration is
 * INCOMPLETE. A deployed OpeniWatch that quietly serves browser-local demo data
 * because its Supabase variables did not reach the build is worse than one that
 * refuses to start: an operator would see a plausible dashboard, acknowledge
 * fictional alerts, and believe the location was being watched. So outside
 * local development this configuration fails closed.
 */

/** Where this build believes it is running, derived from VITE_ENVIRONMENT_LABEL. */
export type DeploymentEnvironment = 'development' | 'staging' | 'production'

export interface BrowserEnv {
  supabaseUrl: string
  /**
   * The Supabase **publishable** key (`sb_publishable_...`).
   *
   * Not the legacy `anon` JWT. Publishable keys rotate independently of the
   * project's JWT signing secret, so revoking one does not invalidate every
   * live session, and they are not confusable with a secret key by shape.
   */
  supabasePublishableKey: string
  defaultOrgName: string
  enableSimulator: boolean
  spyglassBaseUrl: string
  oneSignalAppId: string
  /**
   * Mirrors the server-side OPENIWATCH_ENABLE_SMS flag so the interface can say
   * why SMS is off. It does NOT enable sending — only the Edge Function can do
   * that, and it requires its own server-side flag.
   */
  enableSms: boolean
  /** Raw label shown in the environment badge, e.g. "Staging". Empty hides it. */
  environmentLabel: string
  /** Normalized form of the label, used for every policy decision below. */
  deployment: DeploymentEnvironment
}

/**
 * The outcome of reading configuration.
 *
 * `blocked` is a first-class state, not an error thrown from deep inside a
 * provider: the application renders a configuration screen and initializes no
 * data provider at all.
 */
export type Configuration =
  | { status: 'supabase'; env: BrowserEnv }
  | { status: 'local-demo'; env: BrowserEnv }
  | {
      status: 'blocked'
      env: BrowserEnv
      /** Variable NAMES only. Never a value. */
      missing: string[]
      /** Variable NAMES whose value is present but unusable. Never a value. */
      invalid: string[]
      /**
       * True when the deployment still sets the legacy browser variable.
       *
       * Lets the configuration screen say "rename this" rather than "this is
       * missing", which is the difference between a two-minute fix and an hour
       * of wondering why a key that is plainly present is not being read.
       */
      legacyVariableInUse: boolean
      /** Stable, non-sensitive code an administrator can quote in a ticket. */
      reference: string
    }

/** The two variables the browser needs in order to reach the real backend. */
export const REQUIRED_SUPABASE_VARS = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
] as const

/**
 * The legacy browser variable, named here only so it can be recognised and
 * refused. It is never read as a source of configuration.
 */
export const LEGACY_BROWSER_KEY_VAR = 'VITE_SUPABASE_ANON_KEY'

/** Shape of a Supabase publishable key. Browser-safe by design. */
const PUBLISHABLE_KEY_PATTERN = /^sb_publishable_[A-Za-z0-9_-]{10,}$/

/**
 * Shape of a Supabase **secret** key. Recognised so it can be refused.
 *
 * A secret key in a `VITE_` variable would be compiled into a JavaScript file
 * that anyone can download. Detecting it by shape means the mistake fails the
 * build's own configuration check rather than shipping.
 */
const SECRET_KEY_PATTERN = /^sb_secret_/

/** A legacy JWT-format key (`anon` or `service_role`). */
const LEGACY_JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

type RawEnv = Record<string, unknown>

function readString(raw: RawEnv, key: string, fallback = ''): string {
  const value = raw[key]
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
}

function readBoolean(raw: RawEnv, key: string): boolean {
  return readString(raw, key).toLowerCase() === 'true'
}

/**
 * Normalizes the free-text environment label.
 *
 * Anything that is not recognisably staging or production is treated as
 * development. That direction is deliberate: an unrecognised label must not
 * silently gain production's stricter guarantees under a name nobody checked,
 * and a developer must not be locked out by a typo. The strictness is applied
 * by `VITE_ENABLE_LOCAL_DEMO` having to be set explicitly in every case.
 */
export function normalizeEnvironment(label: string): DeploymentEnvironment {
  const value = label.trim().toLowerCase()
  if (value === 'production' || value === 'prod') return 'production'
  if (value === 'staging' || value === 'stage') return 'staging'
  return 'development'
}

/** True when a value is a usable absolute http(s) URL. */
function isUsableUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Builds the administrator-facing reference code.
 *
 * Deterministic, derived only from which variable NAMES are absent or
 * unusable and which environment is in play. It contains no value, no length,
 * no hash and no encoding of a secret — quoting it in a support ticket or a
 * screenshot reveals nothing beyond what the screen already states.
 */
function configurationReference(
  deployment: DeploymentEnvironment,
  missing: string[],
  invalid: string[],
): string {
  const scope = { development: 'DEV', staging: 'STG', production: 'PRD' }[deployment]
  const flags = [
    missing.includes('VITE_SUPABASE_URL') ? 'U' : '',
    missing.includes('VITE_SUPABASE_PUBLISHABLE_KEY') ? 'K' : '',
    invalid.length > 0 ? 'X' : '',
  ]
    .filter(Boolean)
    .join('')
  return `OW-CFG-${scope}-${flags || 'NONE'}`
}

/**
 * Resolves configuration from a raw environment record.
 *
 * Pure and exported so the rules below are testable without a browser, a build,
 * or a module cache to reset between cases.
 *
 * The rules, in order:
 *
 *  1. Supabase URL and anon key both present and usable -> talk to Supabase.
 *     This holds in every environment, so a correctly configured staging build
 *     never depends on any of the flags below.
 *  2. Otherwise, in staging or production -> BLOCKED. The local demo provider is
 *     never substituted for a real backend in a deployed environment, whatever
 *     VITE_ENABLE_LOCAL_DEMO says.
 *  3. Otherwise, in development, only when VITE_ENABLE_LOCAL_DEMO=true ->
 *     local demo. Demo mode is now opt-in rather than the consequence of an
 *     empty variable, which is what made the deployed fallback silent.
 *  4. Otherwise -> BLOCKED.
 */
export function resolveConfiguration(raw: RawEnv): Configuration {
  const environmentLabel = readString(raw, 'VITE_ENVIRONMENT_LABEL')
  const deployment = normalizeEnvironment(environmentLabel)

  const supabaseUrl = readString(raw, 'VITE_SUPABASE_URL')
  const supabasePublishableKey = readString(raw, 'VITE_SUPABASE_PUBLISHABLE_KEY')
  /*
   * Read only to detect it, never to use it.
   *
   * The legacy variable is deliberately NOT a fallback. A silent fallback would
   * mean a deployment that "works" while still authenticating with a legacy
   * anon JWT, and nobody would find out until the key was rotated. A
   * deployment that still has only the old variable set must fail closed and
   * say which name to use.
   */
  const legacyBrowserKey = readString(raw, LEGACY_BROWSER_KEY_VAR)

  const env: BrowserEnv = {
    supabaseUrl,
    supabasePublishableKey,
    defaultOrgName: readString(raw, 'VITE_DEFAULT_ORG_NAME', 'Openi Security Services'),
    // Explicit opt-in only. Previously this defaulted to on, which meant a
    // deployment had to remember to switch it off. See docs/SECURITY.md.
    enableSimulator: readBoolean(raw, 'VITE_ENABLE_SIMULATOR'),
    spyglassBaseUrl: readString(raw, 'VITE_SPYGLASS_BASE_URL'),
    oneSignalAppId: readString(raw, 'VITE_ONESIGNAL_APP_ID'),
    enableSms: readBoolean(raw, 'VITE_ENABLE_SMS'),
    environmentLabel,
    deployment,
  }

  const missing: string[] = []
  const invalid: string[] = []
  if (!supabaseUrl) missing.push('VITE_SUPABASE_URL')
  else if (!isUsableUrl(supabaseUrl)) invalid.push('VITE_SUPABASE_URL')

  if (!supabasePublishableKey) {
    missing.push('VITE_SUPABASE_PUBLISHABLE_KEY')
  } else if (SECRET_KEY_PATTERN.test(supabasePublishableKey)) {
    /*
     * A secret key in the browser variable.
     *
     * This is the most damaging configuration mistake available here: an
     * `sb_secret_` key bypasses Row Level Security entirely, and a VITE_
     * variable is compiled into a file anyone can download. Refusing by shape
     * turns it into a blocking screen instead of a silent full-database
     * disclosure.
     */
    invalid.push('VITE_SUPABASE_PUBLISHABLE_KEY')
  } else if (LEGACY_JWT_PATTERN.test(supabasePublishableKey)) {
    // A legacy anon JWT pasted under the new name. It would very likely work
    // against Supabase today, which is exactly why it is refused here: the
    // migration would look complete while the deployment still depended on a
    // key the project is trying to retire.
    invalid.push('VITE_SUPABASE_PUBLISHABLE_KEY')
  } else if (!PUBLISHABLE_KEY_PATTERN.test(supabasePublishableKey)) {
    invalid.push('VITE_SUPABASE_PUBLISHABLE_KEY')
  }

  if (missing.length === 0 && invalid.length === 0) {
    return { status: 'supabase', env }
  }

  const blocked: Configuration = {
    status: 'blocked',
    env,
    missing,
    invalid,
    // A legacy anon JWT or a publishable key sitting under the old name both
    // count: either way the fix is to set VITE_SUPABASE_PUBLISHABLE_KEY.
    // Set at all, whatever it contains: either way the fix is the same.
    legacyVariableInUse: legacyBrowserKey.length > 0,
    reference: configurationReference(deployment, missing, invalid),
  }

  // A deployed environment never falls back to browser-local data.
  if (deployment !== 'development') return blocked

  if (readBoolean(raw, 'VITE_ENABLE_LOCAL_DEMO')) {
    return { status: 'local-demo', env }
  }

  return blocked
}

export const configuration: Configuration = resolveConfiguration(
  import.meta.env as unknown as RawEnv,
)

export const env: BrowserEnv = configuration.env

/** True when the browser is configured to reach a real Supabase project. */
export const isSupabaseConfigured = configuration.status === 'supabase'

export type DataMode = 'supabase' | 'local-demo'

/**
 * The provider to construct. `null` when configuration is blocked — the
 * application must not build a provider at all in that case, which is what
 * stops demo data reaching a deployed screen.
 */
export const dataMode: DataMode | null =
  configuration.status === 'blocked' ? null : configuration.status

/**
 * Whether the signal simulator may be reached in this build.
 *
 * Three independent conditions, all required:
 *   - never in production, whatever the flag says. The simulator writes signals
 *     into the operational database; a production deployment has no legitimate
 *     use for fabricated ones;
 *   - VITE_ENABLE_SIMULATOR must be exactly "true";
 *   - the signed-in role must be permitted to submit signals — checked at the
 *     route and in the navigation, not here.
 *
 * Demo mode does not grant simulator access by itself.
 */
export function isSimulatorAvailable(config: Configuration = configuration): boolean {
  if (config.env.deployment === 'production') return false
  return config.env.enableSimulator
}

export const simulatorEnabled = isSimulatorAvailable()
