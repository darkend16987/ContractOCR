// Nabu PDF — license admin config.
// Both values are PUBLIC (safe to commit/ship): the anon key only grants what
// Row Level Security allows, and all reads are gated by is_admin().
window.NABU_CFG = {
  SUPABASE_URL: "https://gaqwijsudxpfydruozmd.supabase.co",
  // anon (public) key — safe to commit. Supabase → Settings → API → anon public.
  SUPABASE_ANON_KEY:
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdhcXdpanN1ZHhwZnlkcnVvem1kIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyNTgzOTUsImV4cCI6MjA5NzgzNDM5NX0.l7nna-AwNWq23Ak1VqqwbaBDI08msaFsePsyeacU6C0",
};
