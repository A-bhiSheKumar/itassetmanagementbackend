import type { CustomFieldType } from './customFieldValues.js';

/**
 * Starter setups, one per kind of estate.
 *
 * Nothing here is a code path: a preset only decides which categories, types
 * and fields a brand-new organisation starts with, and what the product calls
 * things. Everything it seeds can be renamed, archived or replaced afterwards,
 * and an organisation whose estate matches none of them can start from blank.
 *
 * This is what makes the product industry-neutral in practice rather than in
 * principle — a plant-hire firm should not have to delete "Laptop" before it
 * can add "Excavator".
 */

export interface Vocabulary {
  /** What one tracked thing is called: asset, vehicle, tool, device. */
  asset: string;
  assets: string;
  /** What a holder is called: employee, driver, clinician, student. */
  person: string;
  people: string;
}

export interface ModuleSwitches {
  /** Repairs, servicing and inspections. */
  maintenance: boolean;
  /** Software licences and seats — irrelevant to plenty of estates. */
  licences: boolean;
  /** Suppliers, repairers and publishers. */
  vendors: boolean;
}

interface PresetField {
  appliesTo: 'asset' | 'person';
  label: string;
  type: CustomFieldType;
  options?: string[];
  /** Types this field applies to, by preset type key. Empty: all of them. */
  forTypes?: string[];
  showInTable?: boolean;
  required?: boolean;
}

export interface IndustryPreset {
  key: string;
  label: string;
  /** One line, in the words of someone in that industry. */
  description: string;
  vocabulary: Vocabulary;
  modules: ModuleSwitches;
  categories: Array<{ name: string; icon?: string }>;
  types: Array<{ name: string; category: string; tagPrefix: string; requiresSerial: boolean }>;
  fields: PresetField[];
}

const ALL_MODULES: ModuleSwitches = { maintenance: true, licences: true, vendors: true };

export const INDUSTRY_PRESETS: IndustryPreset[] = [
  {
    key: 'it',
    label: 'IT equipment',
    description: 'Laptops, phones, monitors and the software that runs on them.',
    vocabulary: { asset: 'asset', assets: 'assets', person: 'person', people: 'people' },
    modules: ALL_MODULES,
    categories: [
      { name: 'Computers', icon: 'laptop' },
      { name: 'Displays', icon: 'monitor' },
      { name: 'Mobile devices', icon: 'phone' },
      { name: 'Networking', icon: 'router' },
      { name: 'Peripherals', icon: 'keyboard' },
    ],
    types: [
      { name: 'Laptop', category: 'Computers', tagPrefix: 'LAP', requiresSerial: true },
      { name: 'Desktop', category: 'Computers', tagPrefix: 'DSK', requiresSerial: true },
      { name: 'Monitor', category: 'Displays', tagPrefix: 'MON', requiresSerial: false },
      { name: 'Mobile phone', category: 'Mobile devices', tagPrefix: 'MOB', requiresSerial: true },
      { name: 'Accessory', category: 'Peripherals', tagPrefix: 'ACC', requiresSerial: false },
    ],
    fields: [
      { appliesTo: 'asset', label: 'Operating system', type: 'select', options: ['Windows', 'macOS', 'Linux', 'iOS', 'Android'], forTypes: ['Laptop', 'Desktop', 'Mobile phone'] },
      { appliesTo: 'asset', label: 'Encrypted', type: 'boolean', forTypes: ['Laptop', 'Desktop'] },
    ],
  },
  {
    key: 'tools',
    label: 'Tools, plant and machinery',
    description: 'Power tools, access equipment and plant, signed out to sites and crews.',
    vocabulary: { asset: 'item', assets: 'items', person: 'operator', people: 'operators' },
    modules: { ...ALL_MODULES, licences: false },
    categories: [
      { name: 'Power tools', icon: 'tool' },
      { name: 'Access equipment', icon: 'ladder' },
      { name: 'Plant', icon: 'truck' },
      { name: 'Test equipment', icon: 'gauge' },
      { name: 'Site welfare', icon: 'home' },
    ],
    types: [
      { name: 'Power tool', category: 'Power tools', tagPrefix: 'PT', requiresSerial: true },
      { name: 'Ladder or tower', category: 'Access equipment', tagPrefix: 'ACC', requiresSerial: false },
      { name: 'Generator', category: 'Plant', tagPrefix: 'GEN', requiresSerial: true },
      { name: 'Test instrument', category: 'Test equipment', tagPrefix: 'TST', requiresSerial: true },
    ],
    fields: [
      { appliesTo: 'asset', label: 'Next inspection due', type: 'date', showInTable: true },
      { appliesTo: 'asset', label: 'PAT test passed', type: 'boolean' },
      { appliesTo: 'asset', label: 'Hire rate per day', type: 'number' },
    ],
  },
  {
    key: 'fleet',
    label: 'Vehicles and fleet',
    description: 'Vans, cars and trailers, with MOT, tax and service dates.',
    vocabulary: { asset: 'vehicle', assets: 'vehicles', person: 'driver', people: 'drivers' },
    modules: { ...ALL_MODULES, licences: false },
    categories: [
      { name: 'Cars', icon: 'car' },
      { name: 'Vans', icon: 'van' },
      { name: 'Trailers', icon: 'trailer' },
      { name: 'Specialist', icon: 'truck' },
    ],
    types: [
      { name: 'Car', category: 'Cars', tagPrefix: 'CAR', requiresSerial: true },
      { name: 'Van', category: 'Vans', tagPrefix: 'VAN', requiresSerial: true },
      { name: 'Trailer', category: 'Trailers', tagPrefix: 'TRL', requiresSerial: false },
    ],
    fields: [
      { appliesTo: 'asset', label: 'Registration', type: 'text', showInTable: true, required: true },
      { appliesTo: 'asset', label: 'MOT due', type: 'date', showInTable: true },
      { appliesTo: 'asset', label: 'Road tax due', type: 'date' },
      { appliesTo: 'asset', label: 'Mileage', type: 'number' },
      { appliesTo: 'person', label: 'Licence number', type: 'text' },
      { appliesTo: 'person', label: 'Licence expires', type: 'date' },
    ],
  },
  {
    key: 'medical',
    label: 'Medical and lab devices',
    description: 'Clinical and laboratory equipment, with calibration and servicing records.',
    vocabulary: { asset: 'device', assets: 'devices', person: 'clinician', people: 'clinicians' },
    modules: { ...ALL_MODULES, licences: false },
    categories: [
      { name: 'Diagnostic', icon: 'stethoscope' },
      { name: 'Monitoring', icon: 'activity' },
      { name: 'Laboratory', icon: 'flask' },
      { name: 'Ward equipment', icon: 'bed' },
    ],
    types: [
      { name: 'Diagnostic device', category: 'Diagnostic', tagPrefix: 'DIA', requiresSerial: true },
      { name: 'Monitor', category: 'Monitoring', tagPrefix: 'MON', requiresSerial: true },
      { name: 'Lab instrument', category: 'Laboratory', tagPrefix: 'LAB', requiresSerial: true },
    ],
    fields: [
      { appliesTo: 'asset', label: 'Calibration due', type: 'date', showInTable: true },
      { appliesTo: 'asset', label: 'Risk class', type: 'select', options: ['I', 'IIa', 'IIb', 'III'] },
      { appliesTo: 'asset', label: 'Manufacturer reference', type: 'text' },
    ],
  },
  {
    key: 'education',
    label: 'Schools and colleges',
    description: 'Classroom devices, instruments and kit lent to students and staff.',
    vocabulary: { asset: 'item', assets: 'items', person: 'student', people: 'students' },
    modules: ALL_MODULES,
    categories: [
      { name: 'Classroom devices', icon: 'laptop' },
      { name: 'Audio visual', icon: 'projector' },
      { name: 'Science', icon: 'flask' },
      { name: 'Music', icon: 'music' },
      { name: 'Sports', icon: 'ball' },
    ],
    types: [
      { name: 'Tablet', category: 'Classroom devices', tagPrefix: 'TAB', requiresSerial: true },
      { name: 'Laptop', category: 'Classroom devices', tagPrefix: 'LAP', requiresSerial: true },
      { name: 'Projector', category: 'Audio visual', tagPrefix: 'PRJ', requiresSerial: true },
      { name: 'Instrument', category: 'Music', tagPrefix: 'INS', requiresSerial: false },
    ],
    fields: [
      { appliesTo: 'asset', label: 'Room', type: 'text', showInTable: true },
      { appliesTo: 'person', label: 'Year group', type: 'text', showInTable: true },
    ],
  },
  {
    key: 'facilities',
    label: 'Facilities and furniture',
    description: 'Everything in the building: furniture, appliances and fittings.',
    vocabulary: { asset: 'item', assets: 'items', person: 'person', people: 'people' },
    modules: { ...ALL_MODULES, licences: false },
    categories: [
      { name: 'Furniture', icon: 'chair' },
      { name: 'Appliances', icon: 'plug' },
      { name: 'Safety equipment', icon: 'shield' },
      { name: 'Building systems', icon: 'settings' },
    ],
    types: [
      { name: 'Desk', category: 'Furniture', tagPrefix: 'DSK', requiresSerial: false },
      { name: 'Chair', category: 'Furniture', tagPrefix: 'CHR', requiresSerial: false },
      { name: 'Appliance', category: 'Appliances', tagPrefix: 'APP', requiresSerial: true },
      { name: 'Fire equipment', category: 'Safety equipment', tagPrefix: 'FIR', requiresSerial: false },
    ],
    fields: [
      { appliesTo: 'asset', label: 'Next inspection due', type: 'date', showInTable: true },
      { appliesTo: 'asset', label: 'Floor', type: 'text' },
    ],
  },
  {
    key: 'blank',
    label: 'Start from nothing',
    description: 'No categories or types. Build your own taxonomy from the first record.',
    vocabulary: { asset: 'asset', assets: 'assets', person: 'person', people: 'people' },
    modules: ALL_MODULES,
    categories: [],
    types: [],
    fields: [],
  },
];

export const DEFAULT_INDUSTRY = 'it';

export const INDUSTRY_KEYS = INDUSTRY_PRESETS.map((p) => p.key);

export function findPreset(key: string | null | undefined): IndustryPreset {
  return INDUSTRY_PRESETS.find((p) => p.key === key) ?? INDUSTRY_PRESETS[0]!;
}
