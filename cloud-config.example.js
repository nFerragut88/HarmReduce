/*
 * HarmReduce — cloud config TEMPLATE.
 *
 * Copy this file to cloud-config.js and fill in the values.
 * Get them from Supabase → Project Settings → API.
 * Both URL and anon key are SAFE to ship publicly (RLS protects the data).
 * If either is missing/blank, the app stays in local-only mode.
 */

window.HARMREDUCE_SUPABASE = {
  url: "",       // e.g. "https://yourprojectref.supabase.co"
  anonKey: "",   // sb_publishable_... or anon JWT starting with "eyJ..."
};
