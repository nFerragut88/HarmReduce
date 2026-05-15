/*
 * HarmReduce cloud layer.
 *
 * Wraps supabase-js. Exposes a global `cloud` with auth + data methods.
 * Pure browser, no build step. Falls back to a stub if cloud-config.js isn't filled.
 */

(function () {
  "use strict";

  let client = null;
  let session = null;
  let profile = null;

  const subscribers = new Set();
  function notify() {
    for (const s of subscribers) {
      try { s(); } catch (e) { console.warn(e); }
    }
  }

  function isConfigured() {
    const c = window.HARMREDUCE_SUPABASE;
    return !!(c && c.url && c.anonKey && /^https?:\/\//.test(c.url));
  }

  function getClient() {
    if (client) return client;
    if (!isConfigured()) return null;
    if (!window.supabase || !window.supabase.createClient) return null;
    const cfg = window.HARMREDUCE_SUPABASE;
    client = window.supabase.createClient(cfg.url, cfg.anonKey, {
      auth: { persistSession: true, storageKey: "hr.auth" },
    });
    return client;
  }

  async function loadProfile() {
    const c = getClient();
    if (!c || !session) { profile = null; return; }
    const { data, error } = await c.from("profiles").select("*").eq("user_id", session.user.id).maybeSingle();
    if (error) console.warn("loadProfile error", error);
    profile = data || null;
  }

  async function init() {
    const c = getClient();
    if (!c) return null;
    const { data } = await c.auth.getSession();
    session = (data && data.session) || null;
    if (session) await loadProfile();
    c.auth.onAuthStateChange(async (_event, newSession) => {
      session = newSession || null;
      if (session) await loadProfile(); else profile = null;
      notify();
    });
    return session;
  }

  // ----- recovery phrase signup / sign-in -----

  // 256 short common nouns. 8 words from 256 = 64 bits of entropy — plenty
  // for a non-financial recovery flow. Picked for spelling clarity and to
  // avoid homophones/near-homophones.
  const WORDLIST = [
    "amber","anchor","angel","apple","arctic","arrow","atlas","autumn","azure","badge",
    "banana","beach","beacon","beetle","bell","berry","birch","bird","black","blossom",
    "blue","boat","bone","book","boot","brain","brass","brave","bread","brick",
    "bridge","brook","broom","brown","brush","cactus","cake","candle","canyon","carbon",
    "castle","cedar","chair","cherry","chess","cider","cliff","clock","cloud","clover",
    "coal","coast","cobalt","coffee","comet","comic","copper","coral","cotton","crane",
    "creek","crow","crown","crystal","daisy","dawn","deer","delta","desert","dew",
    "diamond","dolphin","dragon","dream","drum","dune","dusk","eagle","earth","ebony",
    "echo","ember","emerald","falcon","feather","fern","field","finch","fire","flag",
    "flame","flint","flower","forest","fox","frost","garden","ginger","glass","glow",
    "gold","granite","grape","grass","gravel","green","harbor","hawk","hazel","heart",
    "herb","hickory","hill","honey","horse","ice","iris","iron","ivory","ivy",
    "jade","jewel","jungle","juniper","kettle","kite","knight","lake","lantern","laurel",
    "leaf","lemon","light","lily","lime","linen","lion","lotus","magnet","maple",
    "marble","marsh","meadow","melody","mint","mirror","mist","moon","moss","music",
    "nectar","night","north","oak","ocean","olive","onyx","opal","orange","orchid",
    "otter","owl","paint","palm","panda","paper","peach","pearl","pebble","pepper",
    "petal","pine","planet","plaza","plum","poem","pond","poppy","prairie","quartz",
    "queen","quill","quince","quiver","rain","raven","red","reef","ribbon","river",
    "robin","rose","ruby","salt","sand","satin","scarlet","sea","seed","shadow",
    "shell","ship","shore","silk","silver","sky","slate","snow","soil","south",
    "spark","sparrow","spice","spring","star","stem","stone","storm","stream","sugar",
    "summer","sunset","swan","sword","tea","thorn","thunder","tiger","tile","topaz",
    "torch","trail","tree","tulip","twig","umbra","unicorn","valley","vapor","velvet",
    "vine","violet","walnut","water","wave","west","wheat","willow","wind","wing",
    "winter","wolf","wood","wool","world","yacht","yard","yarn","yellow","zephyr",
    "zinc",
  ];
  // Trim or pad to exactly 256 so modular arithmetic on a uint8 is unbiased.
  if (WORDLIST.length > 256) WORDLIST.length = 256;
  while (WORDLIST.length < 256) WORDLIST.push("word" + WORDLIST.length);

  function generateRecoveryPhrase() {
    const buf = new Uint8Array(8);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => WORDLIST[b]).join("-");
  }

  function normalizePhrase(p) {
    return String(p || "")
      .trim()
      .toLowerCase()
      .replace(/[\s,]+/g, "-")
      .replace(/-+/g, "-");
  }

  async function derivePassword(phrase, handle) {
    const enc = new TextEncoder();
    // Salt with handle so two users with the same phrase get different passwords.
    const data = enc.encode("harmreduce::v1::" + handle + "::" + phrase);
    const hash = await crypto.subtle.digest("SHA-256", data);
    const bytes = new Uint8Array(hash);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  }

  const SYNTHETIC_EMAIL_DOMAIN = "harmreduce.local";
  const syntheticEmail = (handle) => `${handle}@${SYNTHETIC_EMAIL_DOMAIN}`;

  async function signUpWithRecovery(handle) {
    const c = getClient();
    if (!c) throw new Error("Cloud not configured. Fill in cloud-config.js.");
    handle = String(handle || "").trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) {
      throw new Error("Handle must be 3-20 chars: lowercase letters, digits, underscore.");
    }
    const { data: existing } = await c.from("profiles").select("user_id").eq("handle", handle).maybeSingle();
    if (existing) throw new Error("Handle already taken.");

    const phrase = generateRecoveryPhrase();
    const password = await derivePassword(phrase, handle);

    const { data, error } = await c.auth.signUp({
      email: syntheticEmail(handle),
      password,
    });
    if (error) throw error;
    if (!data.session) {
      // 'Confirm email' is on in Supabase — won't work for our synthetic emails.
      throw new Error("Sign-up returned no session — likely 'Confirm email' is still ON in Supabase. Turn it off under Authentication → Providers → Email.");
    }
    session = data.session;

    const { error: pErr } = await c.from("profiles").insert({ user_id: session.user.id, handle });
    if (pErr) {
      await c.auth.signOut();
      session = null;
      throw pErr;
    }
    await loadProfile();
    notify();
    return { phrase, session };
  }

  async function recoverAccount(handle, phrase) {
    const c = getClient();
    if (!c) throw new Error("Cloud not configured.");
    handle = String(handle || "").trim().toLowerCase();
    const normalized = normalizePhrase(phrase);
    if (!/^[a-z0-9_]{3,20}$/.test(handle)) throw new Error("Invalid handle.");
    if (normalized.split("-").length !== 8) {
      throw new Error("Recovery phrase should be 8 words separated by dashes or spaces.");
    }
    const password = await derivePassword(normalized, handle);
    const { data, error } = await c.auth.signInWithPassword({
      email: syntheticEmail(handle),
      password,
    });
    if (error) {
      throw new Error("Couldn't recover — check the handle and phrase exactly.");
    }
    session = data.session;
    await loadProfile();
    notify();
    return session;
  }

  // Wipe everything the user has on the server and sign out. We can't delete
  // their auth.users row from a client (that requires service_role), but
  // every related table cascades on auth user deletion AND we're explicitly
  // clearing them here so the orphan row is anonymous and harmless.
  async function deleteAllMyData() {
    const c = getClient();
    if (!c || !session) throw new Error("Not signed in.");
    const me = session.user.id;
    // Delete in dependency order (most dependent first). Errors are
    // surfaced but don't abort the chain — we want the user as gone as possible.
    const ops = [
      () => c.from("messages").delete().eq("from_user", me),
      () => c.from("messages").delete().eq("to_user", me),
      () => c.from("bulletin_posts").delete().eq("author_id", me),
      () => c.from("cloud_entries").delete().eq("user_id", me),
      () => c.from("cloud_inventory").delete().eq("user_id", me),
      () => c.from("friendships").delete().eq("from_user", me),
      () => c.from("friendships").delete().eq("to_user", me),
      () => c.from("profiles").delete().eq("user_id", me),
    ];
    const errors = [];
    for (const op of ops) {
      const { error } = await op();
      if (error) errors.push(error.message || String(error));
    }
    await c.auth.signOut();
    session = null;
    profile = null;
    notify();
    return errors;
  }

  async function signOut() {
    const c = getClient();
    if (!c) return;
    await c.auth.signOut();
    session = null;
    profile = null;
    notify();
  }

  // ---------- friends ----------
  async function listFriendships() {
    const c = getClient();
    if (!c || !session) return [];
    // Pull friendships + join the other party's handle in two passes.
    const { data: rows, error } = await c.from("friendships").select("*").order("created_at", { ascending: false });
    if (error) { console.warn(error); return []; }
    const otherIds = [...new Set(rows.flatMap((r) => [r.from_user, r.to_user]))].filter((id) => id !== session.user.id);
    let handles = {};
    if (otherIds.length) {
      const { data: profs } = await c.from("profiles").select("user_id, handle").in("user_id", otherIds);
      handles = Object.fromEntries((profs || []).map((p) => [p.user_id, p.handle]));
    }
    return rows.map((r) => {
      const other = r.from_user === session.user.id ? r.to_user : r.from_user;
      return {
        ...r,
        other_user_id: other,
        other_handle: handles[other] || "(unknown)",
        i_sent: r.from_user === session.user.id,
      };
    });
  }

  async function sendFriendRequest(handle) {
    const c = getClient();
    if (!c || !session) throw new Error("Not signed in.");
    handle = String(handle || "").trim().toLowerCase();
    if (!handle) throw new Error("Enter a handle.");
    const { data: target } = await c.from("profiles").select("user_id, handle").eq("handle", handle).maybeSingle();
    if (!target) throw new Error("No user with handle '" + handle + "'.");
    if (target.user_id === session.user.id) throw new Error("That's you.");
    const { error } = await c.from("friendships").insert({
      from_user: session.user.id,
      to_user: target.user_id,
      status: "pending",
    });
    if (error) {
      if (error.code === "23505") throw new Error("Friendship already exists.");
      throw error;
    }
  }

  async function respondToRequest(id, status) {
    const c = getClient();
    if (!c || !session) throw new Error("Not signed in.");
    const { error } = await c.from("friendships").update({ status }).eq("id", id);
    if (error) throw error;
  }

  async function removeFriendship(id) {
    const c = getClient();
    if (!c || !session) throw new Error("Not signed in.");
    const { error } = await c.from("friendships").delete().eq("id", id);
    if (error) throw error;
  }

  // ---------- inventory sync ----------
  async function listMyCloudInventory() {
    const c = getClient();
    if (!c || !session) return [];
    const { data, error } = await c.from("cloud_inventory").select("*").eq("user_id", session.user.id).order("created_at", { ascending: false });
    if (error) { console.warn(error); return []; }
    return data || [];
  }

  async function listFriendInventory(friendUserId) {
    const c = getClient();
    if (!c || !session) return [];
    const { data, error } = await c.from("cloud_inventory").select("*").eq("user_id", friendUserId).order("created_at", { ascending: false });
    if (error) { console.warn(error); return []; }
    return data || [];
  }

  async function pushInventoryItem(item) {
    const c = getClient();
    if (!c || !session) throw new Error("Not signed in.");
    const { error } = await c.from("cloud_inventory").insert({
      user_id: session.user.id,
      substance: item.substance,
      form: item.form,
      amount: String(item.amount || ""),
      unit: item.unit,
      notes: item.notes || null,
    });
    if (error) throw error;
  }

  async function removeCloudInventoryItem(id) {
    const c = getClient();
    if (!c || !session) throw new Error("Not signed in.");
    const { error } = await c.from("cloud_inventory").delete().eq("id", id);
    if (error) throw error;
  }

  async function syncAllLocalInventoryUp(localItems) {
    // Replace cloud copy with local copy. Simple "last write wins" — caller decides.
    const c = getClient();
    if (!c || !session) throw new Error("Not signed in.");
    await c.from("cloud_inventory").delete().eq("user_id", session.user.id);
    if (localItems.length) {
      const rows = localItems.map((it) => ({
        user_id: session.user.id,
        substance: it.substance,
        form: it.form,
        amount: String(it.amount || ""),
        unit: it.unit,
        notes: it.notes || null,
      }));
      const { error } = await c.from("cloud_inventory").insert(rows);
      if (error) throw error;
    }
  }

  // ---------- messages ----------
  async function listMessagesWith(otherId) {
    const c = getClient();
    if (!c || !session) return [];
    const me = session.user.id;
    const { data, error } = await c.from("messages")
      .select("*")
      .or(`and(from_user.eq.${me},to_user.eq.${otherId}),and(from_user.eq.${otherId},to_user.eq.${me})`)
      .order("created_at", { ascending: true });
    if (error) { console.warn(error); return []; }
    return data || [];
  }

  async function sendMessage(otherId, body) {
    const c = getClient();
    if (!c || !session) throw new Error("Not signed in.");
    body = String(body || "").trim();
    if (!body) return;
    const { error } = await c.from("messages").insert({
      from_user: session.user.id,
      to_user: otherId,
      body,
    });
    if (error) throw error;
  }

  // ---------- entries (dose log + notes, cloud-synced) ----------
  async function listMyCloudEntries() {
    const c = getClient();
    if (!c || !session) return [];
    const { data, error } = await c.from("cloud_entries").select("*").eq("user_id", session.user.id).order("at", { ascending: false });
    if (error) { console.warn(error); return []; }
    return data || [];
  }

  async function listFriendEntries(friendUserId) {
    const c = getClient();
    if (!c || !session) return [];
    const { data, error } = await c.from("cloud_entries").select("*").eq("user_id", friendUserId).order("at", { ascending: false });
    if (error) { console.warn(error); return []; }
    return data || [];
  }

  async function syncAllLocalEntriesUp(localEntries) {
    const c = getClient();
    if (!c || !session) throw new Error("Not signed in.");
    await c.from("cloud_entries").delete().eq("user_id", session.user.id);
    if (localEntries.length) {
      const rows = localEntries.map((it) => ({
        user_id: session.user.id,
        at: it.at || new Date().toISOString(),
        type: it.type || "dose",
        substance: it.substance || null,
        dose: it.dose ? String(it.dose) : null,
        unit: it.unit || null,
        roa: it.roa || null,
        body: it.body || null,
        setting: it.setting || null,
        mindset: it.mindset || null,
        deduction_note: it.deduction_note || null,
      }));
      const { error } = await c.from("cloud_entries").insert(rows);
      if (error) throw error;
    }
  }

  // ---------- bulletin ----------
  async function listBulletinPosts() {
    const c = getClient();
    if (!c || !session) return [];
    const { data, error } = await c.from("bulletin_posts").select("*").order("created_at", { ascending: false });
    if (error) { console.warn(error); return []; }
    return data || [];
  }

  async function postToBulletin(title, body) {
    const c = getClient();
    if (!c || !session) throw new Error("Not signed in.");
    if (!profile) throw new Error("No profile loaded.");
    body = String(body || "").trim();
    if (!body) throw new Error("Empty body.");
    const { error } = await c.from("bulletin_posts").insert({
      author_id: session.user.id,
      author_handle: profile.handle,
      title: String(title || "").trim() || null,
      body,
    });
    if (error) throw error;
  }

  async function deleteBulletinPost(id) {
    const c = getClient();
    if (!c || !session) throw new Error("Not signed in.");
    const { error } = await c.from("bulletin_posts").delete().eq("id", id);
    if (error) throw error;
  }

  function subscribeBulletin(onChange) {
    const c = getClient();
    if (!c) return () => {};
    const channel = c.channel("bulletin")
      .on("postgres_changes", { event: "*", schema: "public", table: "bulletin_posts" }, () => onChange())
      .subscribe();
    return () => { try { c.removeChannel(channel); } catch {} };
  }

  function subscribeFriendships(onChange) {
    const c = getClient();
    if (!c || !session) return () => {};
    const me = session.user.id;
    const channel = c.channel("fs-" + me)
      .on("postgres_changes", { event: "*", schema: "public", table: "friendships" }, (payload) => {
        const row = payload.new || payload.old;
        if (!row) return onChange();
        if (row.from_user === me || row.to_user === me) onChange();
      })
      .subscribe();
    return () => { try { c.removeChannel(channel); } catch {} };
  }

  function subscribeMessages(otherId, onMessage) {
    const c = getClient();
    if (!c || !session) return () => {};
    const me = session.user.id;
    const channel = c.channel("msgs-" + otherId)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => {
        const m = payload.new;
        if (!m) return;
        const between =
          (m.from_user === me && m.to_user === otherId) ||
          (m.from_user === otherId && m.to_user === me);
        if (between) onMessage(m);
      })
      .subscribe();
    return () => { try { c.removeChannel(channel); } catch {} };
  }

  // ---------- public surface ----------
  window.cloud = {
    isConfigured,
    init,
    onChange: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    getSession: () => session,
    getProfile: () => profile,
    signUpWithRecovery,
    recoverAccount,
    signOut,
    deleteAllMyData,
    listFriendships,
    sendFriendRequest,
    respondToRequest,
    removeFriendship,
    listMyCloudInventory,
    listFriendInventory,
    pushInventoryItem,
    removeCloudInventoryItem,
    syncAllLocalInventoryUp,
    listMyCloudEntries,
    listFriendEntries,
    syncAllLocalEntriesUp,
    listMessagesWith,
    sendMessage,
    subscribeMessages,
    subscribeFriendships,
    listBulletinPosts,
    postToBulletin,
    deleteBulletinPost,
    subscribeBulletin,
  };
})();
