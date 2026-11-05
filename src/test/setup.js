// Runs before every test file. The app's only database is production, so tests are fixture-only by design:
// the Supabase config is blanked, src/lib/supabase.js cannot be imported, and the network is refused.
import { vi } from 'vitest'

process.env.TZ = 'Asia/Manila'

vi.stubEnv('VITE_SUPABASE_URL', '')
vi.stubEnv('VITE_SUPABASE_ANON_KEY', '')

vi.mock('../lib/supabase.js', () => {
  throw new Error('tests must not touch the database: do not import src/lib/supabase.js from a test (use fixtures)')
})

const refuse = () => { throw new Error('tests must not use the network (use fixtures)') }
globalThis.fetch = refuse
globalThis.WebSocket = class { constructor() { refuse() } }
