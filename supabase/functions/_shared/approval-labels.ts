// Pure data shared by the Vite client (Approvals page, activity log) and the notify-email Edge
// Function's approval emails. No imports, no Deno/browser globals.
export const FIELD_LABELS: Record<string, string> = {
  move_out:       'Process Move-out',
  move_out_date:  'Move-out Date',
  tenant_details: 'Update Details',
  tenant_profile: 'Edit Tenant Profile',
  transfer:       'Room Transfer',
  rate:           'Rate',
  amount:         'Amount',
  room_config:    'Room Configuration',
  bed_rate:       'Bed Rate Change',
  remove_bed:     'Remove Bed',
  add_addon:      'Add Add-on',
  delete_addon:   'Delete Add-on',
  interim_reading_delete: 'Delete Interim Reading',
}

export const PROFILE_FIELD_LABELS: Record<string, string> = {
  name:                   'Name',
  gender:                 'Gender',
  source:                 'Source',
  permanent_address:      'Permanent Address',
  occupation:             'Occupation',
  employer:               'Employer',
  employer_address:       'Employer Address',
  employer_contact_no:    'Employer Contact No',
  location_of_work:       'Location of Work',
  work_schedule:          'Work Schedule',
  emergency_contact_name: 'Emergency Contact Name',
  emergency_contact_no:   'Emergency Contact No',
}

export const ENTITY_LABELS: Record<string, string> = {
  TENANT:          'Tenant',
  TENANT_STAY:     'Tenant',
  BED:             'Bed',
  ROOM:            'Room',
  PAYMENT:         'Payment',
  ADDON:           'Add-on',
  INTERIM_READING: 'Meter Reading',
}

export const ROOM_CONFIG_LABELS: Record<string, string> = {
  room_type:           'Room type',
  room_status:         'Room status',
  original_bed_count:  'Original bed count',
  is_management:       'Management room',
}

// Fields whose values are masked in emails (last 4 digits / first letter + domain).
export const PHONE_FIELDS = ['employer_contact_no', 'emergency_contact_no', 'contact_no'] as const
export const EMAIL_FIELDS = ['email'] as const
