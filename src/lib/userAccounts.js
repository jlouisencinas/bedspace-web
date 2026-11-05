// Helpers for the admin Users page (Add New User).

// supabase.auth.signUp on an email that is already registered and confirmed does NOT fail:
// to stop email enumeration it returns a fake user with an empty `identities` array, keeps the
// existing password, and creates nothing. Treat that response as "email already has an account".
export function isExistingAccountSignup(data) {
  const identities = data?.user?.identities
  return Array.isArray(identities) && identities.length === 0
}

export const EXISTING_ACCOUNT_MESSAGE =
  'This email already has an account. Adding it again does not change its password. ' +
  'Reset the password from the Supabase dashboard (Authentication → Users) instead.'
