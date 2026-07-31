import { THREAT_CATEGORY_SEEDS } from '@/domain/taxonomy'
import { env } from '@/lib/env'
import type {
  EscalationRule,
  LocationAlias,
  LocationContact,
  LocationGeofence,
  OperationalAssignment,
  Organization,
  Program,
  ProtectedLocation,
  ScoringThreshold,
  ThreatCategory,
} from '@/domain/types'

/**
 * Pilot seed data.
 *
 * Mirrors `supabase/migrations/0008_seed_pilot_data.sql` exactly, including the
 * record identifiers, so the browser-local demo provider and a real Supabase
 * deployment describe the same pilot. When one changes, change both.
 *
 * Seven physical locations carry eight operational assignments: Costco #696 in
 * Plano is covered by two.
 */

export const ORG_ID = 'a0000000-0000-4000-8000-000000000001'
export const PROGRAM_ID = 'a0000000-0000-4000-8000-000000000002'

/** Fixed instant used for seeded `created_at` values so demo data is stable. */
const SEED_TIME = '2026-01-06T09:00:00.000Z'

const audited = {
  createdAt: SEED_TIME,
  updatedAt: SEED_TIME,
  createdBy: null,
  updatedBy: null,
}

export const seedOrganization: Organization = {
  id: ORG_ID,
  // Configurable: the security-services partner may be renamed.
  name: env.defaultOrgName,
  slug: 'openi-security-services',
  contactEmail: null,
  isActive: true,
  ...audited,
}

export const seedProgram: Program = {
  id: PROGRAM_ID,
  organizationId: ORG_ID,
  name: 'Costco Pilot',
  slug: 'costco-pilot',
  clientName: 'Costco Wholesale',
  description:
    'Eight-assignment pilot supporting security operations for seven Costco warehouse locations.',
  signalRetentionDays: 365,
  isActive: true,
  ...audited,
}

const locationBase = {
  organizationId: ORG_ID,
  programId: PROGRAM_ID,
  countryCode: 'US',
  addressLine2: null,
  notes: null,
  // Coordinates are approximate values seeded without a paid geocoding
  // service. Accurate enough for vicinity matching; re-geocode before
  // production use.
  geocodeSource: 'seeded_approximate' as const,
  geocodedAt: null,
  isActive: true,
  ...audited,
}

export const LOCATION_IDS = {
  stafford: 'b0000000-0000-4000-8000-000000000001',
  plano: 'b0000000-0000-4000-8000-000000000002',
  newOrleans: 'b0000000-0000-4000-8000-000000000003',
  memphis: 'b0000000-0000-4000-8000-000000000004',
  mtVernon: 'b0000000-0000-4000-8000-000000000005',
  mansfield: 'b0000000-0000-4000-8000-000000000006',
  allentown: 'b0000000-0000-4000-8000-000000000007',
} as const

export const seedLocations: ProtectedLocation[] = [
  {
    ...locationBase,
    id: LOCATION_IDS.stafford,
    facilityNumber: '1487',
    officialName: 'Costco #1487',
    addressLine1: '12717 Network Drive',
    city: 'Stafford',
    county: 'Fort Bend',
    state: 'TX',
    postalCode: '77477',
    latitude: 29.628,
    longitude: -95.556,
    timeZone: 'America/Chicago',
    nearbyLandmarks: ['Southwest Freeway (US-59/I-69)', 'Stafford Centre'],
    storeFeatures: ['Warehouse', 'Fuel station', 'Tire center', 'Surface parking lot'],
  },
  {
    ...locationBase,
    id: LOCATION_IDS.plano,
    facilityNumber: '696',
    officialName: 'Costco #696',
    addressLine1: '1701 Dallas Parkway',
    city: 'Plano',
    county: 'Collin',
    state: 'TX',
    postalCode: '75093',
    latitude: 33.0295,
    longitude: -96.829,
    timeZone: 'America/Chicago',
    nearbyLandmarks: ['Dallas North Tollway', 'Willow Bend'],
    storeFeatures: ['Warehouse', 'Fuel station', 'Pharmacy', 'Surface parking lot'],
  },
  {
    ...locationBase,
    id: LOCATION_IDS.newOrleans,
    facilityNumber: '01147',
    officialName: 'Costco #01147',
    addressLine1: '3900 Dublin St.',
    city: 'New Orleans',
    county: 'Orleans Parish',
    state: 'LA',
    postalCode: '70118',
    latitude: 29.9525,
    longitude: -90.1345,
    timeZone: 'America/Chicago',
    nearbyLandmarks: ['Carrollton', 'Earhart Boulevard', 'Mississippi River levee'],
    storeFeatures: ['Warehouse', 'Fuel station', 'Surface parking lot'],
  },
  {
    ...locationBase,
    id: LOCATION_IDS.memphis,
    facilityNumber: '353',
    officialName: 'Costco #353',
    addressLine1: '3775 Hacks Cross Rd.',
    city: 'Memphis',
    county: 'Shelby',
    state: 'TN',
    postalCode: '38125',
    latitude: 35.0295,
    longitude: -89.8135,
    timeZone: 'America/Chicago',
    nearbyLandmarks: ['Hacks Cross Road corridor', 'Winchester Road'],
    storeFeatures: ['Warehouse', 'Fuel station', 'Tire center', 'Surface parking lot'],
  },
  {
    ...locationBase,
    id: LOCATION_IDS.mtVernon,
    facilityNumber: '1115',
    officialName: 'Costco #1115',
    addressLine1: '7940 Richmond Highway',
    city: 'Alexandria',
    county: 'Fairfax',
    state: 'VA',
    postalCode: '22306',
    latitude: 38.7435,
    longitude: -77.0795,
    timeZone: 'America/New_York',
    nearbyLandmarks: ['Richmond Highway (US-1)', 'Mount Vernon', 'Huntington'],
    storeFeatures: ['Warehouse', 'Fuel station', 'Pharmacy', 'Surface parking lot'],
  },
  {
    ...locationBase,
    id: LOCATION_IDS.mansfield,
    facilityNumber: '1381',
    officialName: 'Costco #1381',
    addressLine1: '1500 US-287',
    addressLine2: 'Building #100',
    city: 'Mansfield',
    county: 'Tarrant',
    state: 'TX',
    postalCode: '76063',
    latitude: 32.5735,
    longitude: -97.1265,
    timeZone: 'America/Chicago',
    nearbyLandmarks: ['US-287 Highway', 'Broad Street'],
    storeFeatures: ['Warehouse', 'Fuel station', 'Surface parking lot'],
  },
  {
    ...locationBase,
    id: LOCATION_IDS.allentown,
    facilityNumber: '1211',
    officialName: 'Costco #1211',
    addressLine1: '791 N. Krocks Rd.',
    city: 'Allentown',
    county: 'Lehigh',
    state: 'PA',
    postalCode: '18106',
    latitude: 40.5765,
    longitude: -75.5595,
    timeZone: 'America/New_York',
    nearbyLandmarks: ['Route 222', 'Hamilton Boulevard', 'Lehigh Valley'],
    storeFeatures: ['Warehouse', 'Fuel station', 'Tire center', 'Surface parking lot'],
  },
]

const aliasSeeds: Array<[keyof typeof LOCATION_IDS, string, LocationAlias['aliasType']]> = [
  ['stafford', 'Costco Stafford', 'colloquial'],
  ['stafford', 'Stafford Costco', 'colloquial'],
  ['plano', 'Costco Plano', 'colloquial'],
  ['plano', 'Plano Costco', 'colloquial'],
  ['newOrleans', 'Costco Carrollton', 'local_reference'],
  ['newOrleans', 'Costco New Orleans', 'colloquial'],
  ['memphis', 'Costco Hacks Cross', 'local_reference'],
  ['memphis', 'Costco Memphis', 'colloquial'],
  // The client's own local reference for #1115.
  ['mtVernon', 'Mt. Vernon', 'local_reference'],
  ['mtVernon', 'Mount Vernon Costco', 'colloquial'],
  ['mtVernon', 'Costco Alexandria', 'colloquial'],
  ['mansfield', 'Costco Mansfield', 'colloquial'],
  ['allentown', 'Costco Allentown', 'colloquial'],
  ['allentown', 'Costco Krocks Road', 'local_reference'],
]

export const seedLocationAliases: LocationAlias[] = aliasSeeds.map(([key, alias, aliasType], i) => ({
  id: `f1000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  locationId: LOCATION_IDS[key],
  alias,
  aliasType,
  ...audited,
}))

/**
 * Eight assignments across seven physical locations.
 * Assignments 2 and 4 both reference Costco #696 in Plano.
 */
const assignmentSeeds: Array<[number, keyof typeof LOCATION_IDS, string, string | null]> = [
  [1, 'stafford', 'Costco 1487 Stafford, TX', null],
  [
    2,
    'plano',
    'Costco 696 Plano, TX Assignment 1',
    'First of two assignments covering the same physical warehouse.',
  ],
  [3, 'newOrleans', 'Costco 01147 New Orleans, LA', null],
  [
    4,
    'plano',
    'Costco 696 Plano, TX Assignment 2',
    'Second of two assignments covering the same physical warehouse.',
  ],
  [5, 'memphis', 'Costco 353 Memphis, TN', null],
  [6, 'mtVernon', 'Costco 1115 Mt. Vernon, VA', null],
  [7, 'mansfield', 'Costco 1381 Mansfield, TX', null],
  [8, 'allentown', 'Costco 1211 Allentown, PA', null],
]

export const seedAssignments: OperationalAssignment[] = assignmentSeeds.map(
  ([number, locationKey, name, coverageNotes]) => ({
    id: `c0000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    organizationId: ORG_ID,
    programId: PROGRAM_ID,
    locationId: LOCATION_IDS[locationKey],
    name,
    assignmentNumber: number,
    coverageNotes,
    isActive: true,
    ...audited,
  }),
)

/** Property, parking and vicinity rings per location. */
export const seedGeofences: LocationGeofence[] = seedLocations.flatMap((location, index) => {
  const rings: Array<[string, number, LocationGeofence['zone']]> = [
    ['Property', 200, 'property'],
    ['Parking area', 400, 'parking'],
    ['Vicinity', 1600, 'vicinity'],
  ]
  return rings.map(([name, radiusMeters, zone], ringIndex) => ({
    id: `f2000000-0000-4000-8000-${String(index * 3 + ringIndex + 1).padStart(12, '0')}`,
    locationId: location.id,
    name,
    shape: 'circle' as const,
    centerLatitude: location.latitude ?? 0,
    centerLongitude: location.longitude ?? 0,
    radiusMeters,
    zone,
    ...audited,
  }))
})

/**
 * Demonstration contacts.
 *
 * These are role placeholders, not real people: the SOC records who it
 * notified, and the pilot must not ship with invented personal contact data.
 */
export const seedLocationContacts: LocationContact[] = seedLocations.flatMap((location, index) => [
  {
    id: `f3000000-0000-4000-8000-${String(index * 2 + 1).padStart(12, '0')}`,
    locationId: location.id,
    fullName: 'Store manager on duty',
    role: 'Store manager',
    email: null,
    phone: null,
    notifyOrder: 10,
    isActive: true,
    ...audited,
  },
  {
    id: `f3000000-0000-4000-8000-${String(index * 2 + 2).padStart(12, '0')}`,
    locationId: location.id,
    fullName: 'Regional loss prevention',
    role: 'Regional manager',
    email: null,
    phone: null,
    notifyOrder: 20,
    isActive: true,
    ...audited,
  },
])

export const seedThreatCategories: ThreatCategory[] = THREAT_CATEGORY_SEEDS.map((seed, index) => ({
  id: `f4000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
  organizationId: ORG_ID,
  key: seed.key,
  label: seed.label,
  group: seed.group,
  baselineSeverity: seed.baselineSeverity,
  severityWeight: seed.severityWeight,
  description: seed.description,
  isActive: true,
  ...audited,
}))

export const seedScoringThresholds: ScoringThreshold = {
  id: 'f5000000-0000-4000-8000-000000000001',
  organizationId: ORG_ID,
  criticalMin: 80,
  highMin: 60,
  moderateMin: 35,
  autoSuppressBelow: 10,
  minimumLocationConfidence: 25,
  scorerId: 'deterministic-v1',
  ...audited,
}

/**
 * Critical alerts walk in-app -> web push -> SMS fallback, then escalate if
 * still unacknowledged. OpeniWatch never notifies emergency services.
 */
export const seedEscalationRules: EscalationRule[] = [
  {
    id: 'f6000000-0000-4000-8000-000000000001',
    organizationId: ORG_ID,
    programId: null,
    severity: 'critical',
    unacknowledgedSeconds: 300,
    escalateTo: 'soc_supervisor',
    channelPath: ['in_app', 'web_push', 'sms'],
    isActive: true,
    ...audited,
  },
  {
    id: 'f6000000-0000-4000-8000-000000000002',
    organizationId: ORG_ID,
    programId: null,
    severity: 'high',
    unacknowledgedSeconds: 900,
    escalateTo: 'soc_supervisor',
    channelPath: ['in_app', 'web_push'],
    isActive: true,
    ...audited,
  },
  {
    id: 'f6000000-0000-4000-8000-000000000003',
    organizationId: ORG_ID,
    programId: null,
    severity: 'moderate',
    unacknowledgedSeconds: 3600,
    escalateTo: 'soc_supervisor',
    channelPath: ['in_app'],
    isActive: true,
    ...audited,
  },
  {
    id: 'f6000000-0000-4000-8000-000000000004',
    organizationId: ORG_ID,
    programId: null,
    severity: 'informational',
    unacknowledgedSeconds: 86400,
    escalateTo: 'soc_supervisor',
    channelPath: ['in_app'],
    isActive: true,
    ...audited,
  },
]

/** Convenience lookup used by the simulator and matching tests. */
export function locationByFacilityNumber(facilityNumber: string): ProtectedLocation | undefined {
  return seedLocations.find((l) => l.facilityNumber === facilityNumber)
}

export function assignmentsForLocation(locationId: string): OperationalAssignment[] {
  return seedAssignments.filter((a) => a.locationId === locationId)
}

/** Primary assignment used when an alert must reference exactly one. */
export function primaryAssignmentForLocation(locationId: string): OperationalAssignment | null {
  return assignmentsForLocation(locationId)[0] ?? null
}
