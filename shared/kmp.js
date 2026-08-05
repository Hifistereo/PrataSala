/* kidmindpath-shared v1.1.0 — the shared child profile store.
   Do not edit in an app copy; edit Hifistereo.github.io/shared/ and re-sync.
   See shared/README.md.

   ── What this is ──────────────────────────────────────────────────────────
   All six KidMindPath sites are served from one origin
   (https://www.kidmindpath.com), so they already share one localStorage. This
   file is the agreed vocabulary on top of it: who is playing, how old they
   are, and what the sound/motion settings should be — so a child is named once
   on the hub instead of once per game.

   ── The one rule ──────────────────────────────────────────────────────────
   The hub WRITES kmp:*. Games only READ it. The single exception is
   noteVisit(), which writes kmp:lastApp so the hub can offer "continue where
   you left off". Because the two directions never touch the same keys, there
   are no write conflicts to reason about, and a game can never corrupt the
   profile.

   Games keep their own storage exactly as it was. The hub reads those keys
   directly to build the collection and the parent rollup — see js/adapters/.

   ── Degrading to nothing ──────────────────────────────────────────────────
   An app opened at hifistereo.github.io/<repo>/ is a DIFFERENT ORIGIN with no
   kmp:* at all, and must keep working exactly as it did before this file
   existed. So every read here is wrapped, every failure returns a default, and
   nothing throws. A game that calls KMP with storage disabled, in private
   mode, or on the wrong origin gets a usable guest profile and carries on.

   This is a classic script, not an ES module, on purpose: KidlaTest transpiles
   its JSX with in-browser Babel and PrataSala runs a design-board runtime, and
   neither can `import`. One <script> tag works in all six. */

(function (global) {
  'use strict';

  var NS = 'kmp:';
  var K_PROFILES = NS + 'profiles';
  var K_ACTIVE = NS + 'active';
  var K_PREFS = NS + 'prefs';
  var K_LAST = NS + 'lastApp';

  var MAX_PROFILES = 4;
  var GUEST_ID = 'guest';

  /* The profile a game sees when nothing has been set up — no name, no age.
     Frozen so a caller cannot mutate the shared default by accident. */
  var GUEST = Object.freeze({
    id: GUEST_ID,
    name: '',
    ageYears: null,
    avatar: 'lapsa',
    guest: true,
  });

  var DEFAULT_PREFS = Object.freeze({ sound: true, reducedMotion: false });

  // ---- storage, defensively ------------------------------------------------

  /** localStorage, or null if it is unavailable (private mode, disabled, Node). */
  function store() {
    try {
      var ls = global.localStorage;
      var probe = NS + '__probe';
      ls.setItem(probe, '1');
      ls.removeItem(probe);
      return ls;
    } catch (e) {
      return null;
    }
  }

  function readRaw(key) {
    var ls = store();
    if (!ls) return null;
    try {
      return ls.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function readJSON(key, fallback) {
    var raw = readRaw(key);
    if (raw === null) return fallback;
    try {
      var parsed = JSON.parse(raw);
      return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
      // Hand-edited or truncated JSON must not take a game down.
      return fallback;
    }
  }

  function writeJSON(key, value) {
    var ls = store();
    if (!ls) return false;
    try {
      ls.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      // Quota full. Not worth interrupting play over.
      return false;
    }
  }

  // ---- profiles ------------------------------------------------------------

  function normaliseProfile(p) {
    if (!p || typeof p !== 'object') return null;
    var id = typeof p.id === 'string' && p.id ? p.id : null;
    if (!id) return null;
    var age = Number(p.ageYears);
    return {
      id: id,
      name: typeof p.name === 'string' ? p.name.slice(0, 16) : '',
      ageYears: isFinite(age) && age > 0 ? age : null,
      avatar: typeof p.avatar === 'string' && p.avatar ? p.avatar : 'lapsa',
      guest: p.guest === true,
      createdAt: typeof p.createdAt === 'string' ? p.createdAt : null,
    };
  }

  /** Every stored profile, malformed entries dropped. Never throws. */
  function profiles() {
    var raw = readJSON(K_PROFILES, []);
    if (!Array.isArray(raw)) return [];
    var out = [];
    for (var i = 0; i < raw.length && out.length < MAX_PROFILES; i++) {
      var p = normaliseProfile(raw[i]);
      if (p) out.push(p);
    }
    return out;
  }

  /**
   * The child currently playing. ALWAYS returns a usable object — a guest when
   * nothing is set up, which is what makes this safe to call from any game on
   * any origin without a null check.
   */
  function activeChild() {
    var list = profiles();
    if (!list.length) return GUEST;
    var id = readRaw(K_ACTIVE);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    // Active id points at a deleted profile: fall back to the first one rather
    // than to guest, so a child does not silently lose their collection.
    return list[0];
  }

  // ---- preferences ---------------------------------------------------------

  /** Global sound / reduced-motion, so a parent sets them once, not five times. */
  function prefs() {
    var stored = readJSON(K_PREFS, null);
    if (!stored || typeof stored !== 'object') return DEFAULT_PREFS;
    return {
      sound: stored.sound !== false,
      reducedMotion: stored.reducedMotion === true,
    };
  }

  // ---- per-child storage keys ---------------------------------------------

  /**
   * Namespace one of a game's own storage keys to the active child, so two
   * siblings do not overwrite each other.
   *
   *   PROGRESS_KEY = KMP.key('burtu-feja-progress')
   *     -> 'burtu-feja-progress:anna-1a2b'
   *
   * With NOBODY set up at all, this returns the base key unchanged. That case
   * is not rare and it matters: this file is vendored into every app, so
   * window.KMP also exists at hifistereo.github.io/<repo>/ — a different origin
   * where kmp:* can never appear — and on kidmindpath.com before anyone has
   * been named. Suffixing there would rename every returning player's storage
   * for no benefit, forcing a migration on people who are not using the hub at
   * all. An explicitly created guest is a real profile with a real id and does
   * get namespaced, which is what lets naming them later keep everything.
   */
  function key(base) {
    var child = activeChild();
    if (child === GUEST) return String(base);
    return String(base) + ':' + child.id;
  }

  /**
   * One-time move of a game's pre-KidMindPath data onto the active child.
   *
   * Call once at boot, before reading anything. Without it, everyone who has
   * played before this change would appear to have lost their progress the
   * moment keys became per-child — the data would still be sitting at the old
   * bare key, just never read again.
   *
   * Only ever moves when the destination is empty, so it cannot clobber a
   * child who already has data, and it is safe to call on every load.
   *
   * @returns {boolean} true if something was moved
   */
  function migrateKey(base) {
    var ls = store();
    if (!ls) return false;
    try {
      var from = String(base);
      var to = key(base);
      if (from === to) return false;
      var existing = ls.getItem(to);
      if (existing !== null) return false;
      var legacy = ls.getItem(from);
      if (legacy === null) return false;
      ls.setItem(to, legacy);
      ls.removeItem(from);
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---- age bands -----------------------------------------------------------

  /**
   * The hub stores one age in years. Each game slices ages differently, so it
   * asks for its own scheme rather than the hub pretending they agree.
   *
   *   'eng'    -> 2 | 5            (pre-literate track | preschool track)
   *   'memory' -> '2-3'|'4-5'|'5-6'
   *   'band'   -> 'toddler'|'preschool'|'school'   (generic)
   *
   * Returns null when the age is unknown, which every caller must treat as
   * "ask, or use your own default" rather than guessing.
   */
  function ageBand(scheme) {
    var y = activeChild().ageYears;
    if (!y) return null;
    switch (scheme) {
      case 'eng':
        return y <= 4 ? 2 : 5;
      case 'memory':
        return y <= 3 ? '2-3' : y <= 5 ? '4-5' : '5-6';
      case 'band':
      default:
        return y <= 3 ? 'toddler' : y <= 6 ? 'preschool' : 'school';
    }
  }

  // ---- last visited --------------------------------------------------------

  /** The only key a game writes. Powers the hub's "continue where you left off". */
  function noteVisit(appId) {
    if (!appId) return;
    writeJSON(K_LAST, { app: String(appId), at: Date.now(), child: activeChild().id });
  }

  function lastVisit() {
    var v = readJSON(K_LAST, null);
    if (!v || typeof v !== 'object' || !v.app) return null;
    return { app: String(v.app), at: Number(v.at) || 0, child: v.child || null };
  }

  // ---- the back bar --------------------------------------------------------

  /**
   * Inject the bar that takes a child back to the hub.
   *
   * Fixed to the top of every screen, one tap to leave. Sets --kmp-bar-h on
   * <html> so the app can offset its own root — all five games are full-screen
   * layouts and an overlaying bar would sit on top of their content.
   *
   * Styling lives entirely in kidmindpath-ui.css and is applied by class: this
   * function sets no inline styles, so it works under `style-src 'self'` with
   * no 'unsafe-inline'.
   *
   * @param {object} opts
   * @param {string} opts.appId      id recorded in kmp:lastApp, e.g. 'KidlaTest'
   * @param {string} [opts.title]    game name shown in the middle of the bar
   * @param {string} [opts.home]     override the hub URL (tests use this)
   * @param {Function} [opts.onLeave] run before navigating — save the round here
   * @returns {HTMLElement|null} the bar, or null if the DOM is not ready
   */
  function homeBar(opts) {
    opts = opts || {};
    if (typeof document === 'undefined' || !document.body) return null;

    var existing = document.querySelector('.kmp-bar');
    if (existing) return existing;

    var home = opts.home || 'https://www.kidmindpath.com/';
    var child = activeChild();

    var bar = document.createElement('div');
    bar.className = 'kmp-bar';
    bar.setAttribute('role', 'navigation');
    bar.setAttribute('aria-label', 'KidMindPath');

    var back = document.createElement('a');
    back.className = 'kmp-bar__back';
    back.href = home;
    var arrow = document.createElement('span');
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '←';
    back.appendChild(arrow);
    back.appendChild(document.createTextNode(' Spēles'));

    // The bar leaves on a plain tap, so anything unsaved has to be written
    // here — this is the last moment before the page goes away. pagehide is
    // not enough on its own: Safari does not reliably fire it on a same-origin
    // navigation started by a link.
    if (typeof opts.onLeave === 'function') {
      back.addEventListener('click', function () {
        try {
          opts.onLeave();
        } catch (e) {
          // A failed save must not trap a parent inside the game.
          console.error('kmp: onLeave failed', e);
        }
      });
    }

    var label = document.createElement('span');
    label.className = 'kmp-bar__title';
    label.textContent = opts.title || '';

    var who = document.createElement('a');
    who.className = 'kmp-bar__who';
    who.href = home + 'kolekcija.html';
    who.textContent = child.guest || !child.name ? '🏆 Krājumi' : '🏆 ' + child.name;

    bar.appendChild(back);
    bar.appendChild(label);
    bar.appendChild(who);
    document.body.insertBefore(bar, document.body.firstChild);

    // Publish the height so layouts can make room. Measured rather than
    // hard-coded, because the bar grows with the safe-area inset on a notched
    // phone and a fixed guess would tuck content under the notch.
    var applyHeight = function () {
      var h = bar.offsetHeight || 0;
      document.documentElement.style.setProperty('--kmp-bar-h', h + 'px');
    };
    applyHeight();
    if (global.addEventListener) {
      global.addEventListener('resize', applyHeight);
      global.addEventListener('orientationchange', applyHeight);
    }

    if (opts.appId) noteVisit(opts.appId);
    return bar;
  }

  // ---- hub-only writes -----------------------------------------------------
  // Games must not call these. They are here rather than in the hub's own code
  // so that the read and write halves of the format stay in one file and
  // cannot drift apart.

  function saveProfiles(list) {
    if (!Array.isArray(list)) return false;
    var clean = [];
    for (var i = 0; i < list.length && clean.length < MAX_PROFILES; i++) {
      var p = normaliseProfile(list[i]);
      if (p) clean.push(p);
    }
    return writeJSON(K_PROFILES, clean);
  }

  function setActive(id) {
    var ls = store();
    if (!ls) return false;
    try {
      ls.setItem(K_ACTIVE, String(id));
      return true;
    } catch (e) {
      return false;
    }
  }

  function savePrefs(next) {
    return writeJSON(K_PREFS, {
      sound: next && next.sound !== false,
      reducedMotion: !!(next && next.reducedMotion),
    });
  }

  function makeId(name) {
    var slug = String(name || 'kid')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 10);
    return (slug || 'kid') + '-' + Math.random().toString(36).slice(2, 6);
  }

  /**
   * Remove every kmp:* key and every per-child key belonging to those
   * profiles, plus the games' own legacy keys. Backs the parent area's
   * "delete everything", which the privacy page already promises is possible.
   */
  function deleteAll() {
    var ls = store();
    if (!ls) return false;
    try {
      var doomed = [];
      for (var i = 0; i < ls.length; i++) {
        var k = ls.key(i);
        if (!k) continue;
        if (
          k.indexOf(NS) === 0 ||
          k.indexOf('burtu-feja-') === 0 ||
          k.indexOf('engl.v1.') === 0 ||
          k.indexOf('ciparu-darzs-data') === 0 ||
          k.indexOf('prata-sala-v1') === 0
        ) {
          doomed.push(k);
        }
      }
      for (var j = 0; j < doomed.length; j++) ls.removeItem(doomed[j]);
      return true;
    } catch (e) {
      return false;
    }
  }

  global.KMP = {
    // read — safe to call from any game, on any origin
    activeChild: activeChild,
    profiles: profiles,
    prefs: prefs,
    key: key,
    migrateKey: migrateKey,
    ageBand: ageBand,
    lastVisit: lastVisit,
    noteVisit: noteVisit,
    homeBar: homeBar,
    // write — hub only
    saveProfiles: saveProfiles,
    setActive: setActive,
    savePrefs: savePrefs,
    makeId: makeId,
    deleteAll: deleteAll,
    // constants worth sharing rather than re-declaring
    GUEST: GUEST,
    MAX_PROFILES: MAX_PROFILES,
    VERSION: '1.1.0',
  };

  // So the hub's Node unit tests can require() this file.
  if (typeof module !== 'undefined' && module.exports) module.exports = global.KMP;
})(typeof globalThis !== 'undefined' ? globalThis : this);
