/*
 * HarmReduce — supplemental interaction data.
 *
 * Augments tripsit-drugs.js. App checks TripSit's combos table first; when
 * that has no entry for a pair, it falls through to this list. Sourced
 * from harm-reduction wikis + FDA label warnings, hand-curated.
 *
 * Schema:
 *   drugs: [string, string]              — canonical names
 *   aliases: { [drug]: string[] }        — per-drug aliases (lowercased)
 *   status: "Low Risk" | "Caution" | "Unsafe" | "Dangerous"
 *   note: string                         — one or two sentences, action-oriented
 *   source: string                       — where it came from, for verification
 *
 * Editing rules:
 *   - All names + aliases lowercased.
 *   - Don't add hearsay. Prefer FDA label, PsychonautWiki, peer-reviewed.
 *   - Keep notes terse; users see them inline.
 */

window.HARMREDUCE_EXTRA_COMBOS = [
  // ----- quetiapine (Seroquel) -----
  {
    drugs: ["quetiapine", "cannabis"],
    aliases: { quetiapine: ["seroquel"], cannabis: ["weed", "thc", "marijuana", "hash", "dagga"] },
    status: "Caution",
    note: "Additive CNS depression + both lower seizure threshold. Quetiapine causes orthostatic hypotension; cannabis amplifies dizziness/falls. Smoking quetiapine is not a real ROA — destroys most active compound. Start with a reduced quetiapine dose if combining.",
    source: "PsychonautWiki / FDA label",
  },
  {
    drugs: ["quetiapine", "alcohol"],
    aliases: { quetiapine: ["seroquel"], alcohol: ["ethanol", "booze"] },
    status: "Unsafe",
    note: "Severe additive CNS depression + respiratory suppression. Blackouts and falls likely. Avoid combining at moderate-to-high doses of either.",
    source: "FDA quetiapine label",
  },
  {
    drugs: ["quetiapine", "benzodiazepines"],
    aliases: {
      quetiapine: ["seroquel"],
      benzodiazepines: ["xanax", "alprazolam", "valium", "diazepam", "klonopin", "clonazepam", "ativan", "lorazepam", "benzos"],
    },
    status: "Unsafe",
    note: "Heavy additive sedation, blackouts, falls, respiratory risk. Sometimes co-prescribed but only with monitoring.",
    source: "FDA quetiapine label",
  },
  {
    drugs: ["quetiapine", "opioids"],
    aliases: {
      quetiapine: ["seroquel"],
      opioids: ["heroin", "oxycodone", "oxy", "hydrocodone", "fentanyl", "morphine", "codeine"],
    },
    status: "Dangerous",
    note: "Respiratory depression risk significantly higher than either alone. Avoid stacking. Naloxone on hand if you must.",
    source: "FDA label warnings",
  },

  // ----- gabapentinoid + opioid: black-box -----
  {
    drugs: ["gabapentin", "opioids"],
    aliases: {
      gabapentin: ["neurontin", "gaba"],
      opioids: ["heroin", "oxycodone", "hydrocodone", "fentanyl", "morphine", "methadone", "oxy"],
    },
    status: "Dangerous",
    note: "Major respiratory depression — gabapentin potentiates opioid effects. Common in overdose deaths. FDA black-box warning.",
    source: "FDA black-box warning (2019)",
  },
  {
    drugs: ["pregabalin", "opioids"],
    aliases: {
      pregabalin: ["lyrica"],
      opioids: ["heroin", "oxycodone", "hydrocodone", "fentanyl", "morphine", "methadone"],
    },
    status: "Dangerous",
    note: "Similar to gabapentin: serious respiratory depression risk. Frequently involved in fatal overdoses.",
    source: "FDA pregabalin label",
  },

  // ----- opioid combos that kill -----
  {
    drugs: ["methadone", "benzodiazepines"],
    aliases: {
      methadone: ["dolophine"],
      benzodiazepines: ["xanax", "alprazolam", "valium", "diazepam", "klonopin", "clonazepam", "ativan", "lorazepam", "benzos"],
    },
    status: "Dangerous",
    note: "Major respiratory depression. Very common in fatal overdoses. Don't stack; have naloxone within reach.",
    source: "FDA black-box warning",
  },
  {
    drugs: ["buprenorphine", "benzodiazepines"],
    aliases: {
      buprenorphine: ["suboxone", "subutex", "bupe"],
      benzodiazepines: ["xanax", "alprazolam", "valium", "diazepam", "klonopin", "clonazepam", "ativan", "lorazepam", "benzos"],
    },
    status: "Dangerous",
    note: "Respiratory depression and death documented. Buprenorphine's ceiling effect does NOT protect against this combo.",
    source: "FDA black-box warning",
  },

  // ----- SSRI serotonin issues -----
  {
    drugs: ["ssris", "tramadol"],
    aliases: {
      ssris: ["fluoxetine", "sertraline", "paroxetine", "citalopram", "escitalopram", "prozac", "zoloft", "lexapro", "celexa", "paxil", "ssri"],
      tramadol: ["ultram"],
    },
    status: "Dangerous",
    note: "High serotonin syndrome risk — both elevate serotonin. Watch for agitation, tremor, sweating, fever. Avoid combining.",
    source: "FDA tramadol label",
  },
  {
    drugs: ["ssris", "dxm"],
    aliases: {
      ssris: ["fluoxetine", "sertraline", "paroxetine", "citalopram", "escitalopram", "prozac", "zoloft", "lexapro", "celexa", "paxil", "ssri"],
      dxm: ["dextromethorphan", "robotussin", "robo"],
    },
    status: "Dangerous",
    note: "Serotonin syndrome risk at recreational DXM doses. SSRIs also slow DXM metabolism via CYP2D6 → unpredictable trip strength.",
    source: "PsychonautWiki / case reports",
  },

  // ----- bupropion seizure threshold -----
  {
    drugs: ["bupropion", "amphetamine"],
    aliases: {
      bupropion: ["wellbutrin", "zyban"],
      amphetamine: ["adderall", "speed", "dexamphetamine", "vyvanse", "amp"],
    },
    status: "Unsafe",
    note: "Both lower seizure threshold. Real seizure risk in users with predisposition, sleep deprivation, or dehydration.",
    source: "FDA bupropion label",
  },
  {
    drugs: ["bupropion", "mdma"],
    aliases: {
      bupropion: ["wellbutrin", "zyban"],
      mdma: ["molly", "ecstasy"],
    },
    status: "Unsafe",
    note: "Both lower seizure threshold; MDMA already causes thermal + cardiovascular stress. Seizure + hyperthermia risk.",
    source: "PsychonautWiki",
  },

  // ----- mood stabilizers + psychedelics/stimulants -----
  {
    drugs: ["lithium", "mdma"],
    aliases: { mdma: ["molly", "ecstasy"] },
    status: "Dangerous",
    note: "Significantly increased seizure risk and serotonin toxicity. Multiple case reports of grand mal seizures. Avoid completely.",
    source: "PsychonautWiki / case reports",
  },
  {
    drugs: ["lithium", "psilocybin"],
    aliases: { psilocybin: ["mushrooms", "shrooms", "psilocin"] },
    status: "Dangerous",
    note: "Seizure risk documented with lithium + classical psychedelics. Avoid.",
    source: "PsychonautWiki",
  },
  {
    drugs: ["lamotrigine", "mdma"],
    aliases: { lamotrigine: ["lamictal"], mdma: ["molly", "ecstasy"] },
    status: "Caution",
    note: "Mechanism unclear; anecdotal reports of stronger / unpredictable trips. Not as established as the lithium risk but worth caution.",
    source: "Anecdotal / PsychonautWiki",
  },

  // ----- other antidepressants + cannabis -----
  {
    drugs: ["mirtazapine", "cannabis"],
    aliases: { mirtazapine: ["remeron"], cannabis: ["weed", "thc", "marijuana"] },
    status: "Caution",
    note: "Heavy additive sedation, especially next-day grogginess. Mirtazapine + cannabis at night → impaired coordination next morning.",
    source: "PsychonautWiki",
  },
  {
    drugs: ["trazodone", "cannabis"],
    aliases: { cannabis: ["weed", "thc", "marijuana"] },
    status: "Caution",
    note: "Additive sedation. Trazodone alone is dose-limited by sedation; cannabis amplifies it.",
    source: "Clinical experience",
  },

  // ----- cocaine + alcohol = cocaethylene -----
  {
    drugs: ["cocaine", "alcohol"],
    aliases: { cocaine: ["coke", "blow"], alcohol: ["ethanol", "booze"] },
    status: "Unsafe",
    note: "Liver produces cocaethylene — more cardiotoxic and longer-lasting than cocaine alone. Increased risk of heart attack and sudden cardiac death.",
    source: "Medical literature on cocaethylene",
  },

  // ----- stimulants + beta-blockers: unopposed alpha -----
  {
    drugs: ["stimulants", "beta-blockers"],
    aliases: {
      stimulants: ["cocaine", "amphetamine", "methamphetamine", "mdma", "molly", "adderall"],
      "beta-blockers": ["propranolol", "metoprolol", "atenolol", "bisoprolol"],
    },
    status: "Caution",
    note: "Non-selective beta-blockers in stimulant overdose can cause 'unopposed alpha' → paradoxical hypertension. Labetalol or phentolamine are safer if BP intervention needed.",
    source: "Emergency medicine literature",
  },

  // ----- acetaminophen + alcohol hepatotoxicity -----
  {
    drugs: ["acetaminophen", "alcohol"],
    aliases: { acetaminophen: ["tylenol", "paracetamol", "apap"], alcohol: ["ethanol", "booze"] },
    status: "Unsafe",
    note: "Hepatotoxicity risk, especially with chronic alcohol use. Heavy drinkers: avoid APAP, use NSAIDs cautiously (GI bleed risk) or seek other options.",
    source: "FDA acetaminophen label",
  },
];
