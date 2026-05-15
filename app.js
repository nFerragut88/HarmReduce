/*
 * HarmReduce — phase 1 boilerplate.
 *
 * Static single-page app, vanilla JS, persists everything to localStorage.
 * Each "view" is an object with id/title/render(root). Router swaps views on
 * sidebar nav click. Pure DOM, no framework, no build step.
 *
 * Hooks marked TODO: are where real logic / network calls will land later
 * (drug DB queries, taper math, sync, bulletin board API, chat backend).
 */

(function () {
  "use strict";

  // ---------- tiny utilities ----------

  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (v !== false && v != null) {
        node.setAttribute(k, v);
      }
    }
    for (const c of [].concat(children)) {
      if (c == null || c === false) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  };

  const fmtDate = (iso) => {
    if (!iso) return "";
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    return d.toLocaleString();
  };

  const uid = () => Math.random().toString(36).slice(2, 10);

  // ---------- store (localStorage wrapper) ----------

  const store = {
    NS: "hr.",
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(this.NS + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(this.NS + key, JSON.stringify(value));
      } catch (e) {
        console.warn("store.set failed", e);
      }
    },
    push(key, item) {
      const arr = this.get(key, []);
      arr.push(item);
      this.set(key, arr);
      return arr;
    },
    update(key, id, patch) {
      const arr = this.get(key, []);
      const i = arr.findIndex((x) => x.id === id);
      if (i >= 0) {
        arr[i] = { ...arr[i], ...patch };
        this.set(key, arr);
      }
      return arr;
    },
    remove(key, id) {
      const arr = this.get(key, []).filter((x) => x.id !== id);
      this.set(key, arr);
      return arr;
    },
  };

  // ---------- shared form helpers ----------

  const field = (labelText, inputNode) =>
    el("div", { class: "field" }, [el("label", {}, labelText), inputNode]);

  const input = (name, opts = {}) =>
    el("input", {
      name,
      type: opts.type || "text",
      placeholder: opts.placeholder || "",
      value: opts.value || "",
      step: opts.step,
    });

  const select = (name, options, current) => {
    const s = el("select", { name });
    for (const o of options) {
      const opt = el("option", { value: o.value }, o.label);
      if (o.value === current) opt.selected = true;
      s.appendChild(opt);
    }
    return s;
  };

  const textarea = (name, opts = {}) =>
    el("textarea", {
      name,
      placeholder: opts.placeholder || "",
      rows: opts.rows || 4,
    }, opts.value || "");

  const readForm = (form) => {
    const data = {};
    new FormData(form).forEach((v, k) => (data[k] = String(v).trim()));
    return data;
  };

  // ---------- inventory math ----------

  function isWeightUnit(u) {
    return ["mg", "g", "ug", "µg"].includes(String(u || "").toLowerCase());
  }

  function toMilligrams(amount, unit) {
    const n = Number(amount);
    if (!Number.isFinite(n)) return null;
    switch (String(unit || "").toLowerCase()) {
      case "mg": return n;
      case "g": return n * 1000;
      case "ug":
      case "µg": return n / 1000;
      default: return null;
    }
  }

  function trySubtract(inv, doseAmount, doseUnit) {
    const d = Number(doseAmount);
    const i = Number(inv.amount);
    if (!Number.isFinite(d) || !Number.isFinite(i)) {
      return { ok: false, error: "Numeric amounts required." };
    }
    const sameUnit = String(inv.unit).toLowerCase() === String(doseUnit).toLowerCase();
    if (sameUnit) {
      if (d > i) return { ok: false, error: `Dose ${d} ${doseUnit} exceeds inventory (${i} ${inv.unit}).` };
      return { ok: true, remaining: i - d, unit: inv.unit };
    }
    if (isWeightUnit(inv.unit) && isWeightUnit(doseUnit)) {
      const dMg = toMilligrams(d, doseUnit);
      const iMg = toMilligrams(i, inv.unit);
      if (dMg == null || iMg == null) return { ok: false, error: "Unit conversion failed." };
      if (dMg > iMg) return { ok: false, error: `Dose ${dMg} mg exceeds inventory (${iMg} mg).` };
      const remMg = iMg - dMg;
      // Convert back to the inventory item's original unit.
      let remaining = remMg;
      if (inv.unit === "g") remaining = remMg / 1000;
      else if (inv.unit === "ug" || inv.unit === "µg") remaining = remMg * 1000;
      return { ok: true, remaining, unit: inv.unit };
    }
    return { ok: false, error: `Units don't match: inventory is ${inv.unit}, dose is ${doseUnit}. Can't auto-convert.` };
  }

  // ---------- interaction providers ----------

  async function fetchOpenFdaLabel(name) {
    // openFDA stores names in multiple fields. Try each in priority order so
    // we resolve brand → generic → substance variants of the same drug.
    const safeName = name.replace(/"/g, "");
    const fields = ["generic_name", "brand_name", "substance_name"];
    for (const f of fields) {
      try {
        const url = `https://api.fda.gov/drug/label.json?search=openfda.${f}:"${encodeURIComponent(safeName)}"&limit=1`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const json = await res.json();
        if (json && json.results && json.results[0]) return json.results[0];
      } catch {}
    }
    return null;
  }

  function summarizeOpenFdaInteraction(text, searchTerms) {
    const lower = text.toLowerCase();
    let bestIdx = -1;
    let hitTerm = null;
    for (const t of searchTerms) {
      if (!t || t.length < 3) continue;
      const idx = lower.indexOf(t.toLowerCase());
      if (idx >= 0 && (bestIdx < 0 || idx < bestIdx)) {
        bestIdx = idx;
        hitTerm = t;
      }
    }
    if (bestIdx < 0) return null;
    const start = Math.max(0, bestIdx - 80);
    const end = Math.min(text.length, bestIdx + 240);
    const snippet =
      (start > 0 ? "…" : "") + text.slice(start, end) + (end < text.length ? "…" : "");
    const sLower = snippet.toLowerCase();
    let severity = "noted";
    if (
      sLower.includes("contraindicated") ||
      sLower.includes("do not co-administer") ||
      sLower.includes("do not administer") ||
      sLower.includes("do not use")
    ) severity = "dangerous";
    else if (sLower.includes("avoid")) severity = "unsafe";
    else if (
      sLower.includes("caution") ||
      sLower.includes("monitor") ||
      sLower.includes("may increase") ||
      sLower.includes("may decrease") ||
      sLower.includes("may potentiate") ||
      sLower.includes("reduce dose")
    ) severity = "caution";
    return { severity, snippet, hitTerm };
  }

  const providers = {
    tripsit: {
      name: "TripSit",
      // Reads from the bundled tripsit-drugs.js global. Returns either a
      // documented pairwise combo OR each drug's individual harm-reduction
      // profile (so the user gets something useful even when no specific
      // combo is recorded).
      async check(a, b) {
        const db = window.TRIPSIT_DRUGS;
        if (!db) {
          return { status: "error", note: "tripsit-drugs.js not loaded." };
        }
        const an = a.trim().toLowerCase();
        const bn = b.trim().toLowerCase();

        const lookupDrug = (name) => {
          if (db[name]) return { key: name, entry: db[name] };
          for (const key of Object.keys(db)) {
            const entry = db[key];
            const aliases = (entry && entry.aliases) || [];
            if (key === name || aliases.includes(name)) return { key, entry };
          }
          for (const key of Object.keys(db)) {
            if (key.includes(name) || name.includes(key)) return { key, entry: db[key] };
          }
          return null;
        };

        const findCombo = (drugEntry, target) => {
          if (!drugEntry || !drugEntry.combos) return null;
          const combos = drugEntry.combos;
          if (combos[target]) return combos[target];
          for (const key of Object.keys(combos)) {
            const k = key.toLowerCase();
            if (k === target || k.includes(target) || target.includes(k)) return combos[key];
          }
          return null;
        };

        const drugA = lookupDrug(an);
        const drugB = lookupDrug(bn);
        const combo = findCombo(drugA && drugA.entry, bn) || findCombo(drugB && drugB.entry, an);

        // Fall through to the hand-curated supplemental combos when TripSit
        // has no pairwise entry. Source attribution gets shown in the UI.
        let extra = null;
        if (!combo && Array.isArray(window.HARMREDUCE_EXTRA_COMBOS)) {
          const matches = (input, drug, aliases) => {
            const i = input.toLowerCase();
            const d = drug.toLowerCase();
            if (i === d) return true;
            for (const a of aliases) {
              const al = String(a).toLowerCase();
              if (i === al) return true;
              if (i.includes(al) || al.includes(i)) return true;
            }
            if (d.includes(i) || i.includes(d)) return true;
            return false;
          };
          for (const c of window.HARMREDUCE_EXTRA_COMBOS) {
            if (!c.drugs || c.drugs.length !== 2) continue;
            const [d1, d2] = c.drugs;
            const a1 = (c.aliases && c.aliases[d1]) || [];
            const a2 = (c.aliases && c.aliases[d2]) || [];
            if (
              (matches(an, d1, a1) && matches(bn, d2, a2)) ||
              (matches(an, d2, a2) && matches(bn, d1, a1))
            ) {
              extra = c;
              break;
            }
          }
        }

        const finalCombo = combo || extra;
        return {
          status: finalCombo ? String(finalCombo.status || "unknown").toLowerCase() : "unknown",
          note: finalCombo ? (finalCombo.note || "") : "",
          hasCombo: !!finalCombo,
          fromExtra: !combo && !!extra,
          source: combo ? "TripSit combos" : (extra ? extra.source : null),
          drugA, // { key, entry } or null
          drugB,
          inputA: a,
          inputB: b,
        };
      },
    },
    openfda: {
      name: "openFDA label",
      // Searches each drug's FDA label `drug_interactions` text for mentions of
      // the other drug (using all known brand/generic/substance names). Severity
      // is inferred from keywords ("contraindicated", "avoid", "caution"...).
      async check(a, b) {
        try {
          const [labelA, labelB] = await Promise.all([
            fetchOpenFdaLabel(a),
            fetchOpenFdaLabel(b),
          ]);
          if (!labelA && !labelB) {
            return { status: "unknown", note: `Neither '${a}' nor '${b}' found in openFDA labels.` };
          }
          const namesOf = (label, fallback) => {
            if (!label) return [fallback];
            const o = label.openfda || {};
            const all = [
              fallback,
              ...(o.generic_name || []),
              ...(o.brand_name || []),
              ...(o.substance_name || []),
            ].filter(Boolean);
            return [...new Set(all.map((s) => String(s).trim()))];
          };
          const aTerms = namesOf(labelA, a);
          const bTerms = namesOf(labelB, b);

          let found = null;
          const scan = (label, terms, sideName) => {
            if (!label || !label.drug_interactions) return null;
            for (const txt of label.drug_interactions) {
              const m = summarizeOpenFdaInteraction(txt, terms);
              if (m) return { ...m, side: sideName };
            }
            return null;
          };
          found = scan(labelA, bTerms, a) || scan(labelB, aTerms, b);

          if (!found) {
            const missing = [!labelA ? a : null, !labelB ? b : null].filter(Boolean);
            if (missing.length) {
              return {
                status: "unknown",
                note: `openFDA had no label for: ${missing.join(", ")}. Check spelling. The other drug's label loaded but didn't mention the missing one (since we don't know its real name).`,
              };
            }
            return {
              status: "no-data",
              note: "Both labels loaded, but no mention of one drug in the other's interactions section.",
            };
          }
          return {
            status: found.severity,
            note: `From ${found.side}'s FDA label (matched '${found.hitTerm}'): ${found.snippet}`,
          };
        } catch (e) {
          return { status: "error", note: String((e && e.message) || e) };
        }
      },
    },
  };

  function severityClass(status) {
    const s = String(status || "").toLowerCase();
    if (s.startsWith("dangerous")) return "danger";
    if (s.startsWith("unsafe") || s === "high") return "bad";
    if (s.startsWith("caution") || s === "moderate") return "warn";
    if (s.startsWith("low risk") || s === "low" || s === "safe" || s.startsWith("no risk")) return "good";
    return ""; // unknown / no-data / error
  }

  // ---------- views ----------

  const ROAS = [
    { value: "oral", label: "Oral" },
    { value: "sublingual", label: "Sublingual" },
    { value: "buccal", label: "Buccal" },
    { value: "insufflated", label: "Insufflated" },
    { value: "smoked", label: "Smoked" },
    { value: "vaporized", label: "Vaporized" },
    { value: "rectal", label: "Rectal" },
    { value: "im", label: "IM" },
    { value: "iv", label: "IV" },
    { value: "topical", label: "Topical" },
    { value: "transdermal", label: "Transdermal" },
    { value: "other", label: "Other" },
  ];

  const UNITS = [
    { value: "mg", label: "mg" },
    { value: "ug", label: "µg" },
    { value: "g", label: "g" },
    { value: "ml", label: "mL" },
    { value: "iu", label: "IU" },
    { value: "tab", label: "tab(s)" },
    { value: "cap", label: "cap(s)" },
    { value: "drop", label: "drop(s)" },
  ];

  // ----- 1. Drug Interaction Checker -----
  const interactionsView = {
    id: "interactions",
    title: "Drug Interaction Checker",
    subtitle: "TripSit (harm reduction, local) + openFDA (FDA labels, live). Queried in parallel.",
    icon: "⚠",
    render(root) {
      const form = el("form", { class: "card" }, [
        el("h3", {}, "Pairwise check"),
        el("p", { class: "help" }, "TripSit uses a bundled drugs DB (recreational substances, aliases). openFDA searches FDA-submitted drug labels for cross-mentions. Neither is exhaustive — cross-reference if it matters."),
        el("div", { class: "row" }, [
          field("Substance A", input("a", { placeholder: "e.g. MDMA" })),
          field("Substance B", input("b", { placeholder: "e.g. ssris" })),
        ]),
        el("div", { class: "actions" }, [
          el("button", { type: "submit", class: "primary" }, "Check"),
        ]),
      ]);
      const resultBox = el("div", { id: "ix-result" });

      const fmtTiming = (obj) => {
        if (!obj) return "";
        if (typeof obj === "string") return obj;
        const v = obj.value || obj.Value || "";
        const u = obj._unit || obj.unit || "";
        return v + (u ? " " + u : "");
      };

      const renderDrugCard = (lookup, input) => {
        if (!lookup) {
          return el("div", { class: "sub-card" }, [
            el("h4", {}, input),
            el("p", { class: "help" }, "Not found in TripSit's database."),
          ]);
        }
        const e = lookup.entry;
        const name = e.pretty_name || lookup.key;
        const aliases = e.aliases || [];
        const cats = e.categories || [];
        const summary = e.properties && e.properties.summary;
        const advice = e.properties && e.properties["general-advice"];

        const card = el("div", { class: "sub-card" }, [el("h4", {}, name)]);

        if (cats.length) {
          card.appendChild(el("div", { class: "lib-tags" }, cats.map((c) => el("span", { class: "pill" }, c))));
        }
        if (aliases.length) {
          card.appendChild(el("p", { class: "help" }, [el("strong", {}, "Aliases: "), aliases.join(", ")]));
        }
        if (summary) card.appendChild(el("p", {}, summary));

        if (e.formatted_dose && typeof e.formatted_dose === "object") {
          const routes = Object.keys(e.formatted_dose);
          if (routes.length) {
            const levels = ["Threshold", "Light", "Common", "Strong", "Heavy"];
            const used = levels.filter((l) => routes.some((r) => e.formatted_dose[r] && e.formatted_dose[r][l]));
            const headerCells = [el("th", {}, "Route"), ...used.map((l) => el("th", {}, l))];
            const rows = routes.map((r) => {
              const d = e.formatted_dose[r] || {};
              return el("tr", {}, [el("td", { class: "route" }, r), ...used.map((l) => el("td", {}, d[l] || "—"))]);
            });
            card.appendChild(el("p", { class: "help", style: "margin:8px 0 4px" }, "Dose ladder — 'Heavy' is high-risk territory, not 'max safe dose'."));
            card.appendChild(el("table", { class: "dose-table" }, [
              el("thead", {}, el("tr", {}, headerCells)),
              el("tbody", {}, rows),
            ]));
          }
        }

        const timing = [];
        if (e.formatted_onset) timing.push("Onset: " + fmtTiming(e.formatted_onset));
        if (e.formatted_duration) timing.push("Duration: " + fmtTiming(e.formatted_duration));
        if (e.formatted_aftereffects) timing.push("After-effects: " + fmtTiming(e.formatted_aftereffects));
        if (timing.length) {
          card.appendChild(el("p", { class: "help" }, timing.join(" · ")));
        }

        if (advice) {
          card.appendChild(el("p", { class: "help" }, [el("strong", {}, "HR note: "), advice]));
        }

        return card;
      };

      const renderTripSit = (result) => {
        const cls = severityClass(result.status);
        const wrap = el("div", { class: "result" });
        const providerLabel = result.fromExtra ? "Supplemental DB" : "TripSit";
        const header = el("div", {}, [el("strong", {}, providerLabel + ": ")]);
        if (result.hasCombo) {
          header.appendChild(el("span", { class: "pill " + cls }, result.status || "?"));
          if (result.source) {
            header.appendChild(el("span", { class: "help", style: "margin-left:8px" }, "source: " + result.source));
          }
        } else {
          header.appendChild(el("span", { class: "pill" }, "no documented combo"));
          header.appendChild(el("span", { class: "help", style: "margin-left:8px" }, "— showing each drug's profile below"));
        }
        wrap.appendChild(header);
        if (result.note) {
          wrap.appendChild(el("p", { class: "help", style: "margin-top:6px;color:var(--text)" }, result.note));
        }
        wrap.appendChild(renderDrugCard(result.drugA, result.inputA));
        wrap.appendChild(renderDrugCard(result.drugB, result.inputB));
        return wrap;
      };

      const renderGeneric = (providerKey, result) => {
        const p = providers[providerKey];
        const cls = severityClass(result.status);
        return el("div", { class: "result" }, [
          el("div", {}, [
            el("strong", {}, p.name + ": "),
            el("span", { class: "pill " + cls }, result.status || "?"),
          ]),
          result.note ? el("p", { class: "help", style: "margin-top:6px;color:var(--text)" }, result.note) : null,
        ]);
      };

      const renderResult = (providerKey, result) => {
        if (providerKey === "tripsit") return renderTripSit(result);
        return renderGeneric(providerKey, result);
      };

      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const { a, b } = readForm(form);
        resultBox.innerHTML = "";
        if (!a || !b) {
          resultBox.appendChild(el("div", { class: "result" }, "Enter both substances."));
          return;
        }
        resultBox.appendChild(el("div", { class: "result" }, "Checking TripSit + openFDA…"));

        const results = await Promise.all([
          providers.tripsit.check(a, b),
          providers.openfda.check(a, b),
        ]);
        resultBox.innerHTML = "";
        resultBox.appendChild(renderResult("tripsit", results[0]));
        resultBox.appendChild(renderResult("openfda", results[1]));
      });

      root.appendChild(form);
      root.appendChild(resultBox);
    },
  };

  // ----- 2. Taper Scheduler -----
  const taperView = {
    id: "taper",
    title: "Taper Scheduler",
    subtitle: "Generate a step-down schedule for a substance.",
    icon: "↘",
    render(root) {
      const form = el("form", { class: "card" }, [
        el("h3", {}, "New taper"),
        el("p", { class: "help" }, "Linear taper preview. Phase 2 will add hyperbolic / 10%-rule / benzo-specific math, equivalents tables, and saving the schedule."),
        el("div", { class: "row" }, [
          field("Substance", input("substance", { placeholder: "e.g. clonazepam" })),
          field("Unit", select("unit", UNITS, "mg")),
        ]),
        el("div", { class: "row" }, [
          field("Current dose", input("current", { type: "number", step: "0.01", placeholder: "1.0" })),
          field("Target dose", input("target", { type: "number", step: "0.01", placeholder: "0" })),
        ]),
        el("div", { class: "row" }, [
          field("# of steps", input("steps", { type: "number", placeholder: "8" })),
          field("Days per step", input("interval", { type: "number", placeholder: "7" })),
        ]),
        el("div", { class: "actions" }, [
          el("button", { type: "submit", class: "primary" }, "Generate"),
          el("button", { type: "button", class: "secondary", onclick: () => preview.innerHTML = "" }, "Clear"),
        ]),
      ]);
      const preview = el("div", { id: "taper-preview" });

      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const d = readForm(form);
        const cur = parseFloat(d.current);
        const tgt = parseFloat(d.target);
        const steps = parseInt(d.steps, 10);
        const days = parseInt(d.interval, 10);
        if (![cur, tgt, steps, days].every(Number.isFinite) || steps < 2 || days < 1) {
          preview.innerHTML = "";
          preview.appendChild(el("div", { class: "result" }, "Fill numeric fields. Steps ≥ 2, days ≥ 1."));
          return;
        }
        // TODO: replace with hyperbolic / per-drug recommended curves.
        const delta = (cur - tgt) / (steps - 1);
        const rows = [];
        const today = new Date();
        for (let i = 0; i < steps; i++) {
          const dose = (cur - delta * i).toFixed(3).replace(/\.?0+$/, "");
          const date = new Date(today);
          date.setDate(date.getDate() + i * days);
          rows.push(el("tr", {}, [
            el("td", {}, String(i + 1)),
            el("td", {}, date.toLocaleDateString()),
            el("td", {}, `${dose} ${d.unit}`),
          ]));
        }
        preview.innerHTML = "";
        preview.appendChild(el("div", { class: "card" }, [
          el("h3", {}, `${d.substance || "(substance)"} — ${steps} steps`),
          el("table", {}, [
            el("thead", {}, el("tr", {}, [el("th", {}, "Step"), el("th", {}, "Date"), el("th", {}, "Dose")])),
            el("tbody", {}, rows),
          ]),
        ]));
      });

      root.appendChild(form);
      root.appendChild(preview);
    },
  };

  // ----- 3. Drug Library -----
  const libraryView = {
    id: "library",
    title: "Drug Library",
    subtitle: "Browse the bundled TripSit database. Dose ranges, timings, combos, harm-reduction notes.",
    icon: "📚",
    render(root) {
      const db = window.TRIPSIT_DRUGS;
      if (!db) {
        root.appendChild(el("div", { class: "card" }, "TripSit drugs database not loaded."));
        return;
      }

      const drugs = Object.entries(db)
        .map(([key, entry]) => ({
          key,
          name: entry.pretty_name || key,
          aliases: entry.aliases || [],
          categories: entry.categories || [],
          entry,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));

      const allCategories = [...new Set(drugs.flatMap((d) => d.categories || []))].sort();

      const state = { search: "", category: null, openKey: null };

      const fmtTiming = (obj) => {
        if (!obj) return "";
        if (typeof obj === "string") return obj;
        const v = obj.value || obj.Value || "";
        const u = obj._unit || obj.unit || "";
        return v + (u ? " " + u : "");
      };

      const fmtPropValue = (v) => {
        if (v == null) return "";
        if (typeof v === "string") return v;
        if (Array.isArray(v)) return v.join(" · ");
        if (typeof v === "object") {
          // for things like properties.dose / properties.duration which can be nested
          return Object.entries(v).map(([k, vv]) => `${k}: ${typeof vv === "string" ? vv : JSON.stringify(vv)}`).join(" · ");
        }
        return String(v);
      };

      const renderDetail = (d) => {
        const e = d.entry;
        const sections = [];

        // categories + aliases pill row
        const headerBits = [];
        if (d.categories.length) {
          for (const c of d.categories) headerBits.push(el("span", { class: "pill" }, c));
        }
        if (headerBits.length) {
          sections.push(el("div", { class: "lib-tags" }, headerBits));
        }
        if (d.aliases.length) {
          sections.push(el("p", { class: "help" }, [el("strong", {}, "Also known as: "), d.aliases.join(", ")]));
        }

        // summary
        if (e.properties && e.properties.summary) {
          sections.push(el("p", {}, e.properties.summary));
        }

        // dose table
        if (e.formatted_dose && typeof e.formatted_dose === "object") {
          const routes = Object.keys(e.formatted_dose);
          if (routes.length) {
            const levels = ["Threshold", "Light", "Common", "Strong", "Heavy"];
            const hasLevel = (lvl) => routes.some((r) => e.formatted_dose[r] && e.formatted_dose[r][lvl]);
            const usedLevels = levels.filter(hasLevel);
            const headerCells = [el("th", {}, "Route"), ...usedLevels.map((l) => el("th", {}, l))];
            const rows = routes.map((r) => {
              const doses = e.formatted_dose[r] || {};
              return el("tr", {}, [
                el("td", { class: "route" }, r),
                ...usedLevels.map((l) => el("td", {}, doses[l] || "—")),
              ]);
            });
            sections.push(el("div", { class: "sub-card" }, [
              el("h4", {}, "Dose"),
              el("table", { class: "dose-table" }, [
                el("thead", {}, el("tr", {}, headerCells)),
                el("tbody", {}, rows),
              ]),
            ]));
          }
        }

        // timing summary
        const timingRows = [];
        if (e.formatted_onset) timingRows.push(["Onset", fmtTiming(e.formatted_onset)]);
        if (e.formatted_duration) timingRows.push(["Duration", fmtTiming(e.formatted_duration)]);
        if (e.formatted_aftereffects) timingRows.push(["After-effects", fmtTiming(e.formatted_aftereffects)]);
        if (timingRows.length) {
          sections.push(el("div", { class: "sub-card" }, [
            el("h4", {}, "Timing"),
            el("table", {}, [el("tbody", {}, timingRows.map(([k, v]) =>
              el("tr", {}, [el("td", { class: "muted prop-key" }, k), el("td", {}, v)])
            ))]),
          ]));
        }

        // notes / harm reduction — pull selected properties keys in a curated order
        if (e.properties && typeof e.properties === "object") {
          const PRIORITY = ["general-advice", "after-effects", "marquis", "detection", "test-kits", "avoid", "psychoactive-class", "chemical-class"];
          const seen = new Set();
          const propRows = [];
          for (const k of PRIORITY) {
            if (e.properties[k]) {
              propRows.push([k, e.properties[k]]);
              seen.add(k);
            }
          }
          // include any other string properties we haven't covered explicitly
          for (const [k, v] of Object.entries(e.properties)) {
            if (seen.has(k)) continue;
            if (["summary", "aliases", "categories", "dose", "onset", "duration", "wiki"].includes(k)) continue;
            if (typeof v === "string" && v.length) propRows.push([k, v]);
          }
          if (propRows.length) {
            sections.push(el("div", { class: "sub-card" }, [
              el("h4", {}, "Notes / harm reduction"),
              ...propRows.map(([k, v]) => el("div", { class: "prop" }, [
                el("div", { class: "muted prop-key" }, k.replace(/[-_]/g, " ")),
                el("div", {}, fmtPropValue(v)),
              ])),
            ]));
          }
        }

        // combos
        if (e.combos && typeof e.combos === "object") {
          const comboRows = Object.entries(e.combos)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([target, c]) => {
              const cls = severityClass(c.status || "");
              return el("tr", {}, [
                el("td", {}, target),
                el("td", {}, el("span", { class: "pill " + cls }, c.status || "?")),
                el("td", { class: "combo-note" }, c.note || ""),
              ]);
            });
          if (comboRows.length) {
            sections.push(el("div", { class: "sub-card" }, [
              el("h4", {}, "Interactions"),
              el("table", { class: "combo-table" }, [
                el("thead", {}, el("tr", {}, ["With", "Status", "Notes"].map((h) => el("th", {}, h)))),
                el("tbody", {}, comboRows),
              ]),
            ]));
          }
        }

        // dose note (caveat for the dose ranges)
        if (e.dose_note) {
          sections.push(el("p", { class: "help" }, [el("strong", {}, "Dose note: "), e.dose_note]));
        }

        // links
        const links = [];
        if (e.links && typeof e.links === "object") {
          for (const [k, v] of Object.entries(e.links)) {
            if (typeof v === "string" && /^https?:\/\//.test(v)) {
              links.push(el("a", { href: v, target: "_blank", rel: "noopener noreferrer" }, k));
            }
          }
        }
        if (e.properties && e.properties.wiki && /^https?:\/\//.test(e.properties.wiki)) {
          links.push(el("a", { href: e.properties.wiki, target: "_blank", rel: "noopener noreferrer" }, "wiki"));
        }
        if (e.sources && Array.isArray(e.sources)) {
          for (const s of e.sources) {
            if (typeof s === "string" && /^https?:\/\//.test(s)) {
              links.push(el("a", { href: s, target: "_blank", rel: "noopener noreferrer" }, s.replace(/^https?:\/\//, "").split("/")[0]));
            }
          }
        }
        if (links.length) {
          const linksWrap = el("div", { class: "lib-links" });
          links.forEach((a, i) => {
            if (i > 0) linksWrap.appendChild(document.createTextNode(" · "));
            linksWrap.appendChild(a);
          });
          sections.push(el("div", { class: "sub-card" }, [el("h4", {}, "Links"), linksWrap]));
        }

        return el("div", { class: "library-detail" }, sections);
      };

      // --- top controls ---
      const searchInput = input("q", { placeholder: "Search by name or alias (e.g. molly, ket, dxm)" });
      searchInput.addEventListener("input", () => {
        state.search = searchInput.value.trim().toLowerCase();
        renderList();
      });

      const chipsWrap = el("div", { class: "chips" });
      const renderChips = () => {
        chipsWrap.innerHTML = "";
        const mk = (label, val) =>
          el("button", {
            type: "button",
            class: "chip" + (state.category === val ? " active" : ""),
            onclick: () => { state.category = val; renderChips(); renderList(); },
          }, label);
        chipsWrap.appendChild(mk("all", null));
        for (const c of allCategories) chipsWrap.appendChild(mk(c, c));
      };

      const topCard = el("div", { class: "card" }, [
        el("h3", {}, `Library (${drugs.length} drugs)`),
        field("Search", searchInput),
        field("Category", chipsWrap),
      ]);

      const listWrap = el("div");

      const renderList = () => {
        const filtered = drugs.filter((d) => {
          if (state.category && !d.categories.includes(state.category)) return false;
          if (!state.search) return true;
          if (d.name.toLowerCase().includes(state.search)) return true;
          if (d.key.toLowerCase().includes(state.search)) return true;
          return d.aliases.some((a) => String(a).toLowerCase().includes(state.search));
        });
        listWrap.innerHTML = "";
        if (!filtered.length) {
          listWrap.appendChild(el("div", { class: "empty" }, "No matches."));
          return;
        }
        for (const d of filtered) {
          const isOpen = state.openKey === d.key;
          const row = el("button", {
            type: "button",
            class: "library-row" + (isOpen ? " open" : ""),
            onclick: () => { state.openKey = isOpen ? null : d.key; renderList(); },
          }, [
            el("span", { class: "library-name" }, d.name),
            el("span", { class: "library-cats muted" }, (d.categories || []).join(" · ") || ""),
            el("span", { class: "library-toggle" }, isOpen ? "▾" : "▸"),
          ]);
          const wrap = el("div", { class: "library-item" + (isOpen ? " open" : "") }, [row]);
          if (isOpen) wrap.appendChild(renderDetail(d));
          listWrap.appendChild(wrap);
        }
      };

      root.appendChild(topCard);
      root.appendChild(listWrap);
      renderChips();
      renderList();
    },
  };

  // ----- 4. Inventory -----
  const inventoryView = {
    id: "inventory",
    title: "Inventory",
    subtitle: "What you have on hand. Local by default; can sync to cloud for friends.",
    icon: "📦",
    render(root) {
      const KEY = "inventory";
      let viewing = "me";
      let friends = [];

      const selectorArea = el("div");
      const syncArea = el("div");
      const formArea = el("div");
      const list = el("div");
      root.appendChild(selectorArea);
      root.appendChild(syncArea);
      root.appendChild(formArea);
      root.appendChild(list);

      const form = el("form", { class: "card" }, [
        el("h3", {}, "Add to inventory (local)"),
        el("div", { class: "row" }, [
          field("Substance", input("substance", { placeholder: "e.g. ketamine" })),
          field("Form", select("form", [
            { value: "powder", label: "powder" },
            { value: "crystal", label: "crystal" },
            { value: "pill", label: "pill" },
            { value: "tab", label: "tab / blotter" },
            { value: "liquid", label: "liquid" },
            { value: "capsule", label: "capsule" },
            { value: "plant", label: "plant matter" },
            { value: "other", label: "other" },
          ])),
        ]),
        el("div", { class: "row" }, [
          field("Amount", input("amount", { type: "number", step: "0.001", placeholder: "1.0" })),
          field("Unit", select("unit", UNITS, "g")),
        ]),
        field("Notes", input("notes", { placeholder: "source, batch, test results, etc." })),
        el("div", { class: "actions" }, [el("button", { type: "submit", class: "primary" }, "Add")]),
      ]);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const d = readForm(form);
        if (!d.substance || !d.amount) return;
        store.push(KEY, { id: uid(), at: new Date().toISOString(), ...d });
        form.reset();
        renderList();
      });

      const renderSelector = () => {
        selectorArea.innerHTML = "";
        if (!window.cloud || !window.cloud.getSession() || !friends.length) return;
        const opts = [
          { value: "me", label: "Me (local)" },
          ...friends.map((f) => ({ value: f.other_user_id, label: f.other_handle })),
        ];
        const sel = select("viewing", opts, viewing);
        sel.addEventListener("change", () => {
          viewing = sel.value;
          renderFormArea();
          renderList();
        });
        selectorArea.appendChild(el("div", { class: "card" }, [field("Viewing", sel)]));
      };

      const renderSyncControls = () => {
        syncArea.innerHTML = "";
        if (!window.cloud || !window.cloud.getSession()) return;
        const profile = window.cloud.getProfile();
        syncArea.appendChild(el("div", { class: "card" }, [
          el("h3", {}, "Cloud sync"),
          el("p", { class: "help" }, `Signed in as ${profile?.handle || "?"}. Pushing replaces the cloud copy with your local list so accepted friends can see it.`),
          el("div", { class: "actions" }, [
            el("button", { class: "primary", onclick: async (ev) => {
              ev.target.disabled = true;
              try {
                await window.cloud.syncAllLocalInventoryUp(store.get(KEY, []));
                alert("Inventory synced.");
              } catch (err) {
                alert("Sync failed: " + (err.message || err));
              } finally {
                ev.target.disabled = false;
              }
            } }, "Push local → cloud"),
          ]),
        ]));
      };

      const renderFormArea = () => {
        formArea.innerHTML = "";
        if (viewing === "me") formArea.appendChild(form);
      };

      const renderList = async () => {
        list.innerHTML = "";
        if (viewing === "me") {
          const items = store.get(KEY, []);
          if (!items.length) {
            list.appendChild(el("div", { class: "empty" }, "Inventory empty."));
            return;
          }
          const table = el("table", {}, [
            el("thead", {}, el("tr", {}, ["Substance", "Form", "Amount", "Notes", "Added", ""].map((h) => el("th", {}, h)))),
            el("tbody", {}, items.map((it) =>
              el("tr", {}, [
                el("td", {}, it.substance),
                el("td", {}, it.form || "—"),
                el("td", {}, `${it.amount} ${it.unit}`),
                el("td", { class: "muted" }, it.notes || ""),
                el("td", {}, fmtDate(it.at)),
                el("td", {}, el("button", { class: "danger", onclick: () => { store.remove(KEY, it.id); renderList(); } }, "remove")),
              ])
            )),
          ]);
          list.appendChild(table);
        } else {
          list.appendChild(el("div", { class: "empty" }, "Loading…"));
          const items = await window.cloud.listFriendInventory(viewing);
          list.innerHTML = "";
          const friend = friends.find((f) => f.other_user_id === viewing);
          list.appendChild(el("p", { class: "help" }, `Viewing ${friend?.other_handle || "friend"}'s synced inventory (read-only).`));
          if (!items.length) {
            list.appendChild(el("div", { class: "empty" }, "No shared inventory."));
            return;
          }
          const table = el("table", {}, [
            el("thead", {}, el("tr", {}, ["Substance", "Form", "Amount", "Notes"].map((h) => el("th", {}, h)))),
            el("tbody", {}, items.map((it) =>
              el("tr", {}, [
                el("td", {}, it.substance),
                el("td", {}, it.form || "—"),
                el("td", {}, `${it.amount || ""} ${it.unit || ""}`.trim()),
                el("td", { class: "muted" }, it.notes || ""),
              ])
            )),
          ]);
          list.appendChild(table);
        }
      };

      const full = async () => {
        if (window.cloud && window.cloud.getSession()) {
          try {
            friends = (await window.cloud.listFriendships()).filter((f) => f.status === "accepted");
          } catch { friends = []; }
        } else {
          friends = [];
          viewing = "me";
        }
        renderSelector();
        renderSyncControls();
        renderFormArea();
        renderList();
      };
      full();
      const unsubAuth = window.cloud ? window.cloud.onChange(full) : () => {};
      let unsubFs = () => {};
      const rebindFs = () => {
        unsubFs();
        unsubFs = (window.cloud && window.cloud.getSession())
          ? window.cloud.subscribeFriendships(full)
          : () => {};
      };
      rebindFs();
      const unsubAuthRebind = window.cloud ? window.cloud.onChange(rebindFs) : () => {};
      return () => { unsubAuth(); unsubAuthRebind(); unsubFs(); };
    },
  };

  // ----- Dose Entry (now: dose log + notes journal, merged) -----
  const doseEntryView = {
    id: "dose-entry",
    title: "Dose Entry",
    subtitle: "Doses + notes in one chronological log. Doses can deduct from inventory.",
    icon: "💊",
    render(root) {
      const KEY = "doses";

      // One-time migration: fold legacy "reports" rows into "doses" with type=dose.
      (function migrate() {
        const old = store.get("reports", null);
        if (Array.isArray(old) && old.length) {
          const migrated = old.map((r) => ({
            id: r.id || uid(),
            at: r.at || new Date().toISOString(),
            type: "dose",
            substance: r.substance || "",
            dose: r.dose || "",
            unit: r.unit || "",
            roa: r.roa || "",
            body: r.body || "",
            setting: r.setting || "",
            mindset: r.mindset || "",
            deduction_note: r.deduction_note || "",
          }));
          store.set(KEY, store.get(KEY, []).concat(migrated));
          try { localStorage.removeItem(store.NS + "reports"); } catch {}
        }
      })();

      let editing = null;          // entry being edited, or null
      let formType = "dose";       // "dose" | "note"
      let viewing = "me";          // "me" or a friend's user_id
      let friends = [];

      const invOptions = () => [
        { value: "", label: "(none — don't deduct)" },
        ...store.get("inventory", []).map((i) => ({
          value: i.id,
          label: `${i.substance} — ${i.amount} ${i.unit}${i.form ? " (" + i.form + ")" : ""}`,
        })),
      ];

      const selectorArea = el("div");
      const syncArea = el("div");
      const formArea = el("div", { class: "card" });
      const list = el("div");

      const renderForm = () => {
        formArea.innerHTML = "";
        if (editing) formType = editing.type || "dose";

        const typeChips = el("div", { class: "chips" }, [
          el("button", {
            type: "button",
            class: "chip" + (formType === "dose" ? " active" : ""),
            onclick: () => { formType = "dose"; renderForm(); },
          }, "dose"),
          el("button", {
            type: "button",
            class: "chip" + (formType === "note" ? " active" : ""),
            onclick: () => { formType = "note"; renderForm(); },
          }, "note"),
        ]);

        const header = el("h3", {}, editing ? "Edit entry" : "New entry");
        const typeRow = field("Type", typeChips);

        const formChildren = [header, typeRow];

        if (formType === "dose") {
          formChildren.push(el("div", { class: "row" }, [
            field("Substance", input("substance", { placeholder: "e.g. caffeine", value: (editing && editing.substance) || "" })),
            field("Route", select("roa", ROAS, (editing && editing.roa) || "oral")),
          ]));
          formChildren.push(el("div", { class: "row" }, [
            field("Dose", input("dose", { type: "number", step: "0.001", placeholder: "200", value: (editing && editing.dose) || "" })),
            field("Unit", select("unit", UNITS, (editing && editing.unit) || "mg")),
          ]));
          if (!editing) {
            formChildren.push(field("From inventory (optional)", select("inventory_id", invOptions(), "")));
          }
          formChildren.push(el("div", { class: "row" }, [
            field("Setting (optional)", input("setting", { placeholder: "home, alone w/ music", value: (editing && editing.setting) || "" })),
            field("Mindset (optional)", input("mindset", { placeholder: "calm / anxious", value: (editing && editing.mindset) || "" })),
          ]));
          formChildren.push(field(
            "Notes / report (optional)",
            textarea("body", { rows: 5, placeholder: "T+0:00 dosed…  /  redose, with food, etc.", value: (editing && editing.body) || "" })
          ));
        } else {
          formChildren.push(field(
            "Note",
            textarea("body", { rows: 5, placeholder: "Observation, mood, comedown note, anything — no dose required.", value: (editing && editing.body) || "" })
          ));
        }

        const actions = [
          el("button", { type: "submit", class: "primary" }, editing ? "Save changes" : "Add entry"),
        ];
        if (editing) {
          actions.push(el("button", {
            type: "button",
            class: "secondary",
            onclick: () => { editing = null; formType = "dose"; renderForm(); },
          }, "Cancel"));
        }
        formChildren.push(el("div", { class: "actions" }, actions));

        const form = el("form", {}, formChildren);

        form.addEventListener("submit", (ev) => {
          ev.preventDefault();
          const d = readForm(form);
          if (formType === "dose" && !d.substance) return;
          if (formType === "note" && !d.body) return;

          if (editing) {
            // Edit mode — update in place, don't touch inventory (deduction was for the original action).
            store.update(KEY, editing.id, {
              type: formType,
              substance: d.substance || "",
              dose: d.dose || "",
              unit: d.unit || "",
              roa: d.roa || "",
              body: d.body || "",
              setting: d.setting || "",
              mindset: d.mindset || "",
            });
            editing = null;
            renderForm();
            renderList();
            return;
          }

          // New-entry flow
          let deductionNote = "";
          if (formType === "dose" && d.inventory_id) {
            const inv = store.get("inventory", []).find((x) => x.id === d.inventory_id);
            if (!inv) {
              alert("Selected inventory item is gone. Save again without deducting, or refresh.");
              return;
            }
            const res = trySubtract(inv, d.dose, d.unit);
            if (!res.ok) {
              alert("Couldn't deduct from inventory: " + res.error);
              return;
            }
            if (res.remaining <= 1e-6) {
              store.remove("inventory", inv.id);
              deductionNote = `Depleted ${inv.substance} from inventory.`;
            } else {
              const formatted = Number(res.remaining.toFixed(6)).toString();
              store.update("inventory", inv.id, { amount: formatted });
              deductionNote = `Deducted ${d.dose} ${d.unit} → ${formatted} ${res.unit} of ${inv.substance} left.`;
            }
          }

          const entry = {
            id: uid(),
            at: new Date().toISOString(),
            type: formType,
            substance: d.substance || "",
            dose: d.dose || "",
            unit: d.unit || "",
            roa: d.roa || "",
            body: d.body || "",
            setting: d.setting || "",
            mindset: d.mindset || "",
            deduction_note: deductionNote,
          };
          store.push(KEY, entry);
          renderForm();
          renderList();
        });

        formArea.appendChild(form);
      };

      // Render one entry card. `readOnly` strips edit/delete/export buttons
      // (used when viewing a friend's entries).
      const renderEntryCard = (e, readOnly) => {
        const card = el("div", { class: "card" });
        if (e.type === "note") {
          card.appendChild(el("p", { class: "help" }, [
            el("span", { class: "pill" }, "note"),
            " ",
            fmtDate(e.at),
          ]));
          if (e.body) card.appendChild(el("p", { style: "white-space:pre-wrap" }, e.body));
        } else {
          const headBits = [e.substance || "—"];
          if (e.dose) headBits.push(`${e.dose} ${e.unit || ""}`.trim());
          if (e.roa) headBits.push(e.roa);
          card.appendChild(el("h3", {}, headBits.join(" · ")));
          const meta = [fmtDate(e.at)];
          if (e.setting) meta.push("set: " + e.setting);
          if (e.mindset) meta.push("mindset: " + e.mindset);
          card.appendChild(el("p", { class: "help" }, meta.join(" · ")));
          if (e.deduction_note) {
            card.appendChild(el("p", { class: "help" }, [
              el("span", { class: "pill todo" }, "inventory"),
              " ",
              e.deduction_note,
            ]));
          }
          if (e.body) card.appendChild(el("p", { style: "white-space:pre-wrap" }, e.body));
        }
        if (!readOnly) {
          card.appendChild(el("div", { class: "actions" }, [
            el("button", { class: "secondary", onclick: () => { editing = e; renderForm(); window.scrollTo({ top: 0, behavior: "smooth" }); } }, "edit"),
            el("button", { class: "danger", onclick: () => {
              if (!confirm("Delete this entry?")) return;
              store.remove(KEY, e.id);
              renderList();
            } }, "delete"),
            el("button", { class: "secondary", onclick: () => {
              const blob = new Blob([JSON.stringify(e, null, 2)], { type: "application/json" });
              const a = document.createElement("a");
              a.href = URL.createObjectURL(blob);
              a.download = `entry-${e.id}.json`;
              a.click();
            } }, "export json"),
          ]));
        }
        return card;
      };

      const renderList = async () => {
        list.innerHTML = "";
        if (viewing === "me") {
          const entries = store.get(KEY, []).slice().sort((a, b) => (b.at || "").localeCompare(a.at || ""));
          if (!entries.length) {
            list.appendChild(el("div", { class: "empty" }, "No entries yet."));
            return;
          }
          for (const e of entries) list.appendChild(renderEntryCard(e, false));
        } else {
          list.appendChild(el("div", { class: "empty" }, "Loading…"));
          const items = await window.cloud.listFriendEntries(viewing);
          list.innerHTML = "";
          const friend = friends.find((f) => f.other_user_id === viewing);
          list.appendChild(el("p", { class: "help" }, `Viewing ${friend?.other_handle || "friend"}'s synced dose log (read-only).`));
          if (!items.length) {
            list.appendChild(el("div", { class: "empty" }, "No shared entries."));
            return;
          }
          for (const e of items) list.appendChild(renderEntryCard(e, true));
        }
      };

      const renderSelector = () => {
        selectorArea.innerHTML = "";
        if (!window.cloud || !window.cloud.getSession() || !friends.length) return;
        const opts = [
          { value: "me", label: "Me (local)" },
          ...friends.map((f) => ({ value: f.other_user_id, label: f.other_handle })),
        ];
        const sel = select("viewing", opts, viewing);
        sel.addEventListener("change", () => {
          viewing = sel.value;
          renderFormArea();
          renderList();
        });
        selectorArea.appendChild(el("div", { class: "card" }, [field("Viewing", sel)]));
      };

      const renderSyncControls = () => {
        syncArea.innerHTML = "";
        if (!window.cloud || !window.cloud.getSession()) return;
        if (viewing !== "me") return;
        const profile = window.cloud.getProfile();
        syncArea.appendChild(el("div", { class: "card" }, [
          el("h3", {}, "Cloud sync"),
          el("p", { class: "help" }, `Signed in as ${profile?.handle || "?"}. Pushing replaces the cloud copy with your local log so accepted friends can read it.`),
          el("div", { class: "actions" }, [
            el("button", { class: "primary", onclick: async (ev) => {
              ev.target.disabled = true;
              try {
                await window.cloud.syncAllLocalEntriesUp(store.get(KEY, []));
                alert("Dose log synced.");
              } catch (err) {
                alert("Sync failed: " + (err.message || err));
              } finally {
                ev.target.disabled = false;
              }
            } }, "Push local → cloud"),
          ]),
        ]));
      };

      const renderFormArea = () => {
        formArea.style.display = viewing === "me" ? "" : "none";
      };

      root.appendChild(selectorArea);
      root.appendChild(syncArea);
      root.appendChild(formArea);
      root.appendChild(list);

      const full = async () => {
        if (window.cloud && window.cloud.getSession()) {
          try {
            friends = (await window.cloud.listFriendships()).filter((f) => f.status === "accepted");
          } catch { friends = []; }
        } else {
          friends = [];
          viewing = "me";
        }
        renderSelector();
        renderSyncControls();
        renderFormArea();
        renderForm();
        renderList();
      };
      full();
      const unsubAuth = window.cloud ? window.cloud.onChange(full) : () => {};
      let unsubFs = () => {};
      const rebindFs = () => {
        unsubFs();
        unsubFs = (window.cloud && window.cloud.getSession())
          ? window.cloud.subscribeFriendships(full)
          : () => {};
      };
      rebindFs();
      const unsubAuthRebind = window.cloud ? window.cloud.onChange(rebindFs) : () => {};
      return () => { unsubAuth(); unsubAuthRebind(); unsubFs(); };
    },
  };

  // ----- 7. Bulletin Board (live, rate-limited, rolling 200 cap) -----
  const bulletinView = {
    id: "bulletin",
    title: "Bulletin Board",
    subtitle: "Shared posts. 30s cooldown · 10 per day · 1000 char · oldest of 200 auto-pruned.",
    icon: "📌",
    render(root) {
      const formArea = el("div", { class: "card" });
      const list = el("div");
      root.appendChild(formArea);
      root.appendChild(list);

      const renderForm = () => {
        formArea.innerHTML = "";
        if (!window.cloud || !window.cloud.getSession()) {
          formArea.appendChild(el("p", { class: "help" }, "Sign in on Account & Friends to post."));
          return;
        }
        const titleInput = input("title", { placeholder: "(optional)" });
        const bodyInput = textarea("body", { rows: 3, placeholder: "What's on your mind?" });
        const form = el("form", {}, [
          el("h3", {}, "New post"),
          field("Title", titleInput),
          field("Body", bodyInput),
          el("div", { class: "actions" }, [el("button", { type: "submit", class: "primary" }, "Post")]),
        ]);
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const t = titleInput.value.trim();
          const b = bodyInput.value.trim();
          if (!b) return;
          try {
            await window.cloud.postToBulletin(t, b);
            titleInput.value = "";
            bodyInput.value = "";
          } catch (err) {
            alert("Failed to post: " + (err.message || err));
          }
        });
        formArea.appendChild(form);
      };

      const renderList = async () => {
        if (!window.cloud || !window.cloud.getSession()) {
          list.innerHTML = "";
          return;
        }
        let posts = [];
        try { posts = await window.cloud.listBulletinPosts(); } catch (e) { console.warn(e); }
        list.innerHTML = "";
        if (!posts.length) {
          list.appendChild(el("div", { class: "empty" }, "No posts yet. Be the first."));
          return;
        }
        const meId = window.cloud.getSession()?.user.id;
        for (const p of posts) {
          const card = el("div", { class: "card" });
          if (p.title) card.appendChild(el("h3", {}, p.title));
          card.appendChild(el("p", { class: "help" }, [
            el("span", { class: "pill" }, p.author_handle),
            " · ",
            fmtDate(p.created_at),
          ]));
          card.appendChild(el("p", { style: "white-space:pre-wrap" }, p.body || ""));
          if (p.author_id === meId) {
            card.appendChild(el("div", { class: "actions" }, [
              el("button", { class: "danger", onclick: async () => {
                if (!confirm("Delete this post?")) return;
                try {
                  await window.cloud.deleteBulletinPost(p.id);
                } catch (err) {
                  alert("Delete failed: " + (err.message || err));
                }
              } }, "delete"),
            ]));
          }
          list.appendChild(card);
        }
      };

      const full = async () => {
        renderForm();
        await renderList();
      };
      full();

      let unsubBulletin = () => {};
      const rebindBulletin = () => {
        unsubBulletin();
        unsubBulletin = (window.cloud && window.cloud.getSession())
          ? window.cloud.subscribeBulletin(renderList)
          : () => {};
      };
      rebindBulletin();
      const unsubAuthRebind = window.cloud ? window.cloud.onChange(rebindBulletin) : () => {};
      const unsubAuth = window.cloud ? window.cloud.onChange(full) : () => {};

      return () => {
        unsubBulletin();
        unsubAuthRebind();
        unsubAuth();
      };
    },
  };

  // ----- App Sync / Account & Friends -----
  const syncView = {
    id: "sync",
    title: "Account & Friends",
    subtitle: "Anonymous account, friend list, and local data export.",
    icon: "⇅",
    render(root) {
      const accountCard = el("div", { class: "card" });
      const friendsCard = el("div", { class: "card" });
      const exportCard = el("div", { class: "card" });
      root.appendChild(accountCard);
      root.appendChild(friendsCard);
      root.appendChild(exportCard);

      const renderAccount = () => {
        accountCard.innerHTML = "";
        if (!window.cloud || !window.cloud.isConfigured()) {
          accountCard.appendChild(el("h3", {}, "Cloud not configured"));
          accountCard.appendChild(el("p", { class: "help" }, "To enable friends + chat, set up Supabase:"));
          accountCard.appendChild(el("ol", {}, [
            el("li", {}, "Sign up at supabase.com (free) and create a project"),
            el("li", {}, "Open SQL Editor, paste contents of supabase-schema.sql, run"),
            el("li", {}, "Project Settings → API → copy URL + anon key into cloud-config.js"),
            el("li", {}, "Authentication → Settings → enable Anonymous sign-ins"),
            el("li", {}, "Reload this page"),
          ]));
          return;
        }
        const session = window.cloud.getSession();
        if (!session) {
          const handleInput = input("handle", { placeholder: "3-20 chars, lowercase letters/digits/_" });
          const f = el("form", {}, [
            el("h3", {}, "Sign up (anonymous)"),
            el("p", { class: "help" }, "No email needed. Heads up: if you clear browser data, the account is gone — there's no recovery for anonymous accounts."),
            field("Handle", handleInput),
            el("div", { class: "actions" }, [el("button", { type: "submit", class: "primary" }, "Create account")]),
          ]);
          f.addEventListener("submit", async (e) => {
            e.preventDefault();
            try {
              await window.cloud.signUpAnonymous(handleInput.value);
            } catch (err) {
              alert(err.message || String(err));
            }
          });
          accountCard.appendChild(f);
          return;
        }
        const profile = window.cloud.getProfile();
        accountCard.appendChild(el("h3", {}, "Signed in"));
        accountCard.appendChild(el("p", {}, ["Handle: ", el("strong", {}, profile?.handle || "(none)")]));
        accountCard.appendChild(el("p", { class: "help" }, "Share your handle with friends so they can send you requests."));
        accountCard.appendChild(el("div", { class: "actions" }, [
          el("button", { class: "secondary", onclick: async () => {
            if (!confirm("Sign out?")) return;
            await window.cloud.signOut();
          } }, "Sign out"),
          el("button", { class: "danger", onclick: async (ev) => {
            if (!confirm("This will permanently delete your profile, friendships, synced inventory, dose log, bulletin posts, and messages — then sign you out. This cannot be undone. Continue?")) return;
            if (!confirm("Really, really sure? There's no recovery for anonymous accounts.")) return;
            ev.target.disabled = true;
            try {
              const errs = await window.cloud.deleteAllMyData();
              if (errs.length) {
                alert("Some deletions failed:\n" + errs.join("\n") + "\nYou've been signed out.");
              } else {
                alert("All cloud data deleted. You're signed out.");
              }
            } catch (err) {
              alert("Delete failed: " + (err.message || err));
            }
          } }, "Delete my account + data"),
        ]));
      };

      // Fetch FIRST, then clear+render synchronously — avoids the race where
      // two concurrent calls (initial + auth-state-change) interleave their
      // DOM operations and the form ends up appearing twice.
      const renderFriends = async () => {
        if (!window.cloud || !window.cloud.getSession()) {
          friendsCard.innerHTML = "";
          return;
        }
        let all = [];
        try { all = await window.cloud.listFriendships(); } catch (e) { console.warn(e); }

        friendsCard.innerHTML = "";
        friendsCard.appendChild(el("h3", {}, "Friends"));

        const handleInput = input("handle", { placeholder: "friend's handle" });
        const addForm = el("form", {}, [
          field("Send friend request", handleInput),
          el("div", { class: "actions" }, [el("button", { type: "submit", class: "primary" }, "Send request")]),
        ]);
        addForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          try {
            await window.cloud.sendFriendRequest(handleInput.value);
            handleInput.value = "";
            renderFriends();
          } catch (err) {
            alert(err.message || String(err));
          }
        });
        friendsCard.appendChild(addForm);

        const accepted = all.filter((f) => f.status === "accepted");
        const incoming = all.filter((f) => f.status === "pending" && !f.i_sent);
        const outgoing = all.filter((f) => f.status === "pending" && f.i_sent);

        const section = (title, rows, makeActions) => {
          if (!rows.length) return null;
          return el("div", { style: "margin-top:14px" }, [
            el("h4", {}, title),
            ...rows.map((f) => el("div", { class: "friend-row" }, [
              el("span", { class: "pill" }, f.other_handle),
              el("div", { class: "actions" }, makeActions(f)),
            ])),
          ]);
        };

        const incSec = section("Incoming requests", incoming, (f) => [
          el("button", { class: "primary", onclick: async () => { await window.cloud.respondToRequest(f.id, "accepted"); renderFriends(); } }, "Accept"),
          el("button", { class: "danger", onclick: async () => { await window.cloud.removeFriendship(f.id); renderFriends(); } }, "Decline"),
        ]);
        const accSec = section("Accepted", accepted, (f) => [
          el("button", { class: "danger", onclick: async () => {
            if (!confirm("Remove friendship with " + f.other_handle + "?")) return;
            await window.cloud.removeFriendship(f.id);
            renderFriends();
          } }, "Remove"),
        ]);
        const outSec = section("Outgoing (waiting)", outgoing, (f) => [
          el("button", { class: "danger", onclick: async () => { await window.cloud.removeFriendship(f.id); renderFriends(); } }, "Cancel"),
        ]);

        if (!accepted.length && !incoming.length && !outgoing.length) {
          friendsCard.appendChild(el("p", { class: "help", style: "margin-top:12px" }, "No friends yet."));
        }
        if (incSec) friendsCard.appendChild(incSec);
        if (accSec) friendsCard.appendChild(accSec);
        if (outSec) friendsCard.appendChild(outSec);
      };

      const renderExport = () => {
        exportCard.innerHTML = "";
        exportCard.appendChild(el("h3", {}, "Local export / import"));
        exportCard.appendChild(el("p", { class: "help" }, "Dump all local data to a JSON file, or restore from one. Doesn't touch the cloud."));
        const fileInput = el("input", { type: "file", accept: "application/json", style: "display:none" });
        fileInput.addEventListener("change", () => {
          const f = fileInput.files && fileInput.files[0];
          if (!f) return;
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const parsed = JSON.parse(String(reader.result));
              const data = parsed.data || parsed;
              for (const [k, v] of Object.entries(data)) {
                localStorage.setItem(store.NS + k, JSON.stringify(v));
              }
              alert("Import complete. Refresh views.");
            } catch (err) {
              alert("Bad file: " + err.message);
            }
          };
          reader.readAsText(f);
        });
        exportCard.appendChild(el("div", { class: "actions" }, [
          el("button", { class: "primary", onclick: () => {
            const dump = {};
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k && k.startsWith(store.NS)) {
                try { dump[k.slice(store.NS.length)] = JSON.parse(localStorage.getItem(k)); } catch {}
              }
            }
            const blob = new Blob([JSON.stringify({ schema: 1, exported: new Date().toISOString(), data: dump }, null, 2)], { type: "application/json" });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(blob);
            a.download = `harmreduce-export-${Date.now()}.json`;
            a.click();
          } }, "Export all"),
          el("button", { class: "secondary", onclick: () => fileInput.click() }, "Import…"),
          fileInput,
          el("button", { class: "danger", onclick: () => {
            if (!confirm("Wipe ALL local HarmReduce data? This cannot be undone.")) return;
            const keys = [];
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k && k.startsWith(store.NS)) keys.push(k);
            }
            keys.forEach((k) => localStorage.removeItem(k));
            alert("Wiped.");
          } }, "Wipe local data"),
        ]));
      };

      const full = async () => {
        renderAccount();
        renderExport();
        await renderFriends();
      };
      full();
      const unsubAuth = window.cloud ? window.cloud.onChange(full) : () => {};
      // Resubscribe to friendships whenever auth changes so the realtime
      // channel is bound to the current session.
      let unsubFs = () => {};
      const rebindFs = () => {
        unsubFs();
        unsubFs = (window.cloud && window.cloud.getSession())
          ? window.cloud.subscribeFriendships(renderFriends)
          : () => {};
      };
      rebindFs();
      const unsubAuthRebind = window.cloud ? window.cloud.onChange(rebindFs) : () => {};
      return () => { unsubAuth(); unsubAuthRebind(); unsubFs(); };
    },
  };

  // ----- Chat (real, via Supabase) -----
  const chatView = {
    id: "chat",
    title: "Chat",
    subtitle: "Realtime messaging with accepted friends.",
    icon: "💬",
    render(root) {
      let friends = [];
      let activeFriend = null;
      let messages = [];
      let unsubMessages = null;

      const selectorArea = el("div");
      const chatArea = el("div", { class: "card" });
      root.appendChild(selectorArea);
      root.appendChild(chatArea);

      const renderSelector = () => {
        selectorArea.innerHTML = "";
        if (!window.cloud || !window.cloud.getSession()) {
          chatArea.innerHTML = "";
          chatArea.appendChild(el("p", { class: "help" }, "Sign in on Account & Friends to chat."));
          return;
        }
        if (!friends.length) {
          chatArea.innerHTML = "";
          chatArea.appendChild(el("p", { class: "help" }, "No accepted friends yet — add some on Account & Friends."));
          return;
        }
        const opts = friends.map((f) => ({ value: f.other_user_id, label: f.other_handle }));
        if (!activeFriend || !opts.some((o) => o.value === activeFriend)) {
          activeFriend = opts[0].value;
        }
        const sel = select("friend", opts, activeFriend);
        sel.addEventListener("change", () => {
          activeFriend = sel.value;
          switchFriend();
        });
        selectorArea.appendChild(el("div", { class: "card" }, [field("Chatting with", sel)]));
      };

      const renderMessages = () => {
        chatArea.innerHTML = "";
        const log = el("div", { class: "chat-log" });
        const meId = window.cloud.getSession()?.user.id;
        for (const m of messages) {
          const mine = m.from_user === meId;
          log.appendChild(el("div", { class: "chat-msg" + (mine ? " mine" : "") }, [
            el("div", { class: "chat-meta" }, fmtDate(m.created_at)),
            el("div", { class: "chat-body" }, m.body),
          ]));
        }
        chatArea.appendChild(log);
        setTimeout(() => { log.scrollTop = log.scrollHeight; }, 0);

        const msgInput = input("body", { placeholder: "type a message…" });
        const sendForm = el("form", { class: "chat-input" }, [
          msgInput,
          el("button", { type: "submit", class: "primary" }, "Send"),
        ]);
        sendForm.addEventListener("submit", async (e) => {
          e.preventDefault();
          const v = msgInput.value.trim();
          if (!v || !activeFriend) return;
          msgInput.value = "";
          try {
            await window.cloud.sendMessage(activeFriend, v);
          } catch (err) {
            alert("Send failed: " + (err.message || err));
          }
        });
        chatArea.appendChild(sendForm);
        msgInput.focus();
      };

      const switchFriend = async () => {
        if (unsubMessages) { unsubMessages(); unsubMessages = null; }
        messages = [];
        renderMessages();
        if (!activeFriend) return;
        try { messages = await window.cloud.listMessagesWith(activeFriend); } catch (e) { console.warn(e); }
        renderMessages();
        unsubMessages = window.cloud.subscribeMessages(activeFriend, (m) => {
          messages.push(m);
          renderMessages();
        });
      };

      const full = async () => {
        if (window.cloud && window.cloud.getSession()) {
          try {
            friends = (await window.cloud.listFriendships()).filter((f) => f.status === "accepted");
          } catch { friends = []; }
        } else {
          friends = [];
        }
        renderSelector();
        if (friends.length && window.cloud.getSession()) {
          await switchFriend();
        }
      };
      full();
      const unsubAuth = window.cloud ? window.cloud.onChange(full) : () => {};
      let unsubFs = () => {};
      const rebindFs = () => {
        unsubFs();
        unsubFs = (window.cloud && window.cloud.getSession())
          ? window.cloud.subscribeFriendships(full)
          : () => {};
      };
      rebindFs();
      const unsubAuthRebind = window.cloud ? window.cloud.onChange(rebindFs) : () => {};
      return () => {
        unsubAuth();
        unsubAuthRebind();
        unsubFs();
        if (unsubMessages) unsubMessages();
      };
    },
  };

  // ---------- registry + router ----------

  // ----- About / disclaimer -----
  const aboutView = {
    id: "about",
    title: "About",
    subtitle: "What this app is, what it isn't, and what happens to your data.",
    icon: "ℹ",
    render(root) {
      root.appendChild(el("div", { class: "card" }, [
        el("h3", {}, "What this is"),
        el("p", {}, "HarmReduce is a personal harm-reduction toolkit: drug info, dose / note log, taper scheduler, interaction checker, inventory, plus optional friend-shared inventory + chat + a daily bulletin board."),
        el("p", { class: "help" }, "Free, open-source, no ads, no tracking, no analytics. Source on GitHub (see README)."),
      ]));

      root.appendChild(el("div", { class: "card" }, [
        el("h3", {}, "Not medical advice"),
        el("p", {}, "This is harm-reduction information, not a prescription. Dose ranges from TripSit, interaction data from TripSit + openFDA + hand-curated supplemental entries, drug profiles from PsychonautWiki-style sources. All best-effort, may be incomplete or out of date. Cross-reference anything that matters."),
        el("p", { class: "help" }, "If you're in crisis or think someone is overdosing: call your local emergency line or poison control. In the US: 911 or Poison Control 1-800-222-1222."),
      ]));

      root.appendChild(el("div", { class: "card" }, [
        el("h3", {}, "Where your data lives"),
        el("ul", {}, [
          el("li", {}, [el("strong", {}, "Local-only by default. "), "Inventory, dose log, drafts, current mood/view all stay in your browser's localStorage unless you opt in to cloud sync."]),
          el("li", {}, [el("strong", {}, "Cloud features (Account & Friends, Chat, Bulletin Board, friend-visible inventory) "), "live on a Supabase Postgres instance configured for this deployment. Data is stored in plaintext under row-level security."]),
          el("li", {}, [el("strong", {}, "Accounts are anonymous. "), "No email, no name, no IP-tied identity — just a handle you pick. The trade-off: there's no recovery. If you clear browser data, the account is gone."]),
          el("li", {}, [el("strong", {}, "What others see: "), "Friends you've explicitly accepted can read your synced inventory and dose log. Bulletin posts are visible to all signed-in users. Chat is 1:1."]),
        ]),
      ]));

      root.appendChild(el("div", { class: "card" }, [
        el("h3", {}, "Threat model in plain terms"),
        el("ul", {}, [
          el("li", {}, "Supabase admins / a breach / subpoena could expose cloud-synced data. No PII ties it to you, but your handle is visible."),
          el("li", {}, "The bulletin board is shared and rate-limited (30s cooldown, 10/day, 1000 chars, rolling 200-post cap). No moderation right now — be a good citizen."),
          el("li", {}, "Anyone with your handle can send you a friend request. You choose whether to accept."),
          el("li", {}, "Want everything gone? Account & Friends → 'Delete my account + data' wipes your server-side state."),
        ]),
      ]));

      root.appendChild(el("div", { class: "card" }, [
        el("h3", {}, "Data sources"),
        el("ul", {}, [
          el("li", {}, [el("strong", {}, "TripSit "), "— bundled local copy of their public drugs DB (CC-BY). github.com/TripSit/drugs"]),
          el("li", {}, [el("strong", {}, "openFDA "), "— live calls to the FDA drug label API for pharmaceutical interactions. open.fda.gov"]),
          el("li", {}, [el("strong", {}, "extra-combos.js "), "— hand-curated supplemental interaction notes sourced from PsychonautWiki + FDA labels. Editable; add your own as you verify them."]),
        ]),
      ]));
    },
  };

  const VIEWS = [
    interactionsView,
    taperView,
    libraryView,
    inventoryView,
    doseEntryView,
    bulletinView,
    syncView,
    chatView,
    aboutView,
  ];

  function renderNav() {
    const nav = $("#nav");
    nav.innerHTML = "";
    for (const v of VIEWS) {
      const btn = el("button", {
        type: "button",
        "data-id": v.id,
        onclick: () => go(v.id),
      }, [el("span", { class: "icon" }, v.icon || "•"), v.title]);
      nav.appendChild(btn);
    }
  }

  let currentCleanup = null;

  function go(viewId) {
    const v = VIEWS.find((x) => x.id === viewId) || VIEWS[0];
    if (typeof currentCleanup === "function") {
      try { currentCleanup(); } catch (e) { console.warn(e); }
    }
    currentCleanup = null;
    $("#view-title").textContent = v.title;
    $("#view-subtitle").textContent = v.subtitle || "";
    const root = $("#view");
    root.innerHTML = "";
    for (const btn of document.querySelectorAll("#nav button")) {
      btn.classList.toggle("active", btn.dataset.id === v.id);
    }
    try {
      const result = v.render(root);
      if (typeof result === "function") currentCleanup = result;
    } catch (e) {
      root.appendChild(el("div", { class: "card" }, "Render error: " + e.message));
      console.error(e);
    }
    location.hash = "#" + v.id;
    store.set("last-view", v.id);
  }

  // ---------- boot ----------

  async function boot() {
    renderNav();
    if (window.cloud) {
      try { await window.cloud.init(); } catch (e) { console.warn("cloud.init failed", e); }
    }
    const initial = (location.hash || "").slice(1) || store.get("last-view", "") || VIEWS[0].id;
    go(initial);
    window.addEventListener("hashchange", () => {
      const id = (location.hash || "").slice(1);
      if (id) go(id);
    });
  }

  document.addEventListener("DOMContentLoaded", boot);
})();
