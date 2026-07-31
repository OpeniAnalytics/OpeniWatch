import type { AppRole } from '@/domain/enums'
import type { NotificationSubscription, Profile } from '@/domain/types'
import { LOCATION_IDS, ORG_ID, PROGRAM_ID } from './pilot'

/**
 * Development seed users — one per role.
 *
 * NO PASSWORDS ARE STORED HERE.
 *
 * In local demo mode the application has no authentication server, so you
 * choose a role on the sign-in screen. That is a development affordance and is
 * labelled as such in the interface.
 *
 * For a Supabase deployment, `scripts/seed-users.mjs` creates the matching
 * auth.users records using the Admin API with passwords supplied through the
 * environment at run time. See docs/PILOT_SETUP.md.
 */

export interface SeedUser {
  userId: string
  email: string
  fullName: string
  title: string
  role: AppRole
  timeZone: string
  /** What this account is for, shown on the demo sign-in screen. */
  purpose: string
}

export const SEED_USERS: readonly SeedUser[] = [
  {
    userId: '10000000-0000-4000-8000-000000000001',
    email: 'super.admin@openiwatch.example',
    fullName: 'Avery Sloan',
    title: 'Platform administrator',
    role: 'super_admin',
    timeZone: 'America/Chicago',
    purpose: 'Full platform access across every organization and program.',
  },
  {
    userId: '10000000-0000-4000-8000-000000000002',
    email: 'program.admin@openiwatch.example',
    fullName: 'Dana Whitfield',
    title: 'Program administrator',
    role: 'program_admin',
    timeZone: 'America/Chicago',
    purpose:
      'Manages users, roles, locations, assignments, categories, thresholds and escalation rules for the Costco Pilot.',
  },
  {
    userId: '10000000-0000-4000-8000-000000000003',
    email: 'analyst@openiwatch.example',
    fullName: 'Rowan Estrada',
    title: 'Intelligence analyst',
    role: 'analyst',
    timeZone: 'America/Chicago',
    purpose: 'Reviews the candidate queue and validates alerts. The only role that can validate.',
  },
  {
    userId: '10000000-0000-4000-8000-000000000004',
    email: 'soc.manager@openiwatch.example',
    fullName: 'Kai Brennan',
    title: 'SOC manager',
    role: 'soc_manager',
    timeZone: 'America/Chicago',
    purpose:
      'Acknowledges, assigns, escalates, resolves and dispositions alerts. Cannot validate candidates.',
  },
  {
    userId: '10000000-0000-4000-8000-000000000005',
    email: 'soc.operator@openiwatch.example',
    fullName: 'Jordan Reyes',
    title: 'SOC operator',
    role: 'soc_operator',
    timeZone: 'America/New_York',
    purpose: 'Works assigned alerts. Cannot validate candidates or change administration settings.',
  },
  {
    userId: '10000000-0000-4000-8000-000000000006',
    email: 'viewer@openiwatch.example',
    fullName: 'Sam Okonkwo',
    title: 'Client stakeholder',
    role: 'viewer',
    timeZone: 'America/New_York',
    purpose: 'Read-only access to alerts and reporting. Cannot act on anything.',
  },
]

const SEED_TIME = '2026-01-06T09:00:00.000Z'

export const seedProfiles: Profile[] = SEED_USERS.map((user, index) => ({
  id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  userId: user.userId,
  email: user.email,
  fullName: user.fullName,
  title: user.title,
  phone: null,
  timeZone: user.timeZone,
  isActive: true,
  createdAt: SEED_TIME,
  updatedAt: SEED_TIME,
  createdBy: null,
  updatedBy: null,
}))

/**
 * Default notification subscriptions.
 *
 * The SOC manager and operator are subscribed program-wide so a validated
 * alert always has recipients. The analyst is subscribed to critical only. The
 * viewer has no subscription: read-only users are not paged.
 */
export const seedSubscriptions: NotificationSubscription[] = [
  {
    id: '30000000-0000-4000-8000-000000000001',
    organizationId: ORG_ID,
    userId: SEED_USERS[3]!.userId, // SOC manager
    programId: PROGRAM_ID,
    locationId: null,
    operationalAssignmentId: null,
    severities: [],
    categoryKeys: [],
    channels: ['in_app', 'web_push', 'sms'],
    quietHoursStart: null,
    quietHoursEnd: null,
    isActive: true,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    createdBy: null,
    updatedBy: null,
  },
  {
    id: '30000000-0000-4000-8000-000000000002',
    organizationId: ORG_ID,
    userId: SEED_USERS[4]!.userId, // SOC operator
    programId: PROGRAM_ID,
    locationId: null,
    operationalAssignmentId: null,
    severities: ['critical', 'high', 'moderate'],
    categoryKeys: [],
    channels: ['in_app', 'web_push'],
    quietHoursStart: null,
    quietHoursEnd: null,
    isActive: true,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    createdBy: null,
    updatedBy: null,
  },
  {
    id: '30000000-0000-4000-8000-000000000003',
    organizationId: ORG_ID,
    userId: SEED_USERS[2]!.userId, // Analyst
    programId: PROGRAM_ID,
    locationId: null,
    operationalAssignmentId: null,
    severities: ['critical'],
    categoryKeys: [],
    channels: ['in_app'],
    quietHoursStart: null,
    quietHoursEnd: null,
    isActive: true,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    createdBy: null,
    updatedBy: null,
  },
  {
    // Demonstrates location-scoped subscription: the program administrator
    // watches Stafford specifically.
    id: '30000000-0000-4000-8000-000000000004',
    organizationId: ORG_ID,
    userId: SEED_USERS[1]!.userId, // Program admin
    programId: PROGRAM_ID,
    locationId: LOCATION_IDS.stafford,
    operationalAssignmentId: null,
    severities: ['critical', 'high'],
    categoryKeys: [],
    channels: ['in_app'],
    quietHoursStart: null,
    quietHoursEnd: null,
    isActive: true,
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    createdBy: null,
    updatedBy: null,
  },
]
