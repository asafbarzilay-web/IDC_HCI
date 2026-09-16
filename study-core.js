/* =====================================================================
   study-core.js — the half of a study app that is not about the app.

   Two participant apps now run from this repo: the shapes selector
   (index.html) and the photo app built from the Figma prototype
   (photo.html). Almost none of the instrumentation differs between them.
   Who the participant is, how a session is opened and reopened, how a
   write reaches Supabase without racing the session row it references,
   and how a click becomes a coordinate are all the same question asked
   of two different screens.

   The alternative was a copy of this in each app file, which is the same
   bargain the dashboard turned down: two copies of every rule, and every
   bug fixed twice. Extracted while there was still only one copy to move.

   WHAT AN APP MUST SUPPLY (see configure() below): the element clicks are
   measured against, which screen is showing, and what a click landed on.
   Those are the only three things this file cannot know for itself.

   NOT HERE YET: gaze and the task battery still live in index.html. They
   move next, and nothing in this file's shape assumes they will not.
   ===================================================================== */

window.Study = (function () {
  'use strict';

  const params = new URLSearchParams(location.search);

  // The dashboard opens an app in three non-participating ways: as a
  // static screen behind a heatmap, as an authoring surface to click a
  // route through, and as a live preview of a question. All three read
  // the app; none of them may write to it.
  const PREVIEW_STEP     = params.get('previewStep');
  const AUTHOR_MODE      = params.get('authorMode') === '1';
  const QUESTION_PREVIEW = params.get('previewQuestion') === '1';
  const DEBUG            = params.get('debug') === '1';

  // Defaults chosen so a misconfigured app records nothing rather than
  // recording something wrong. A missing `hitOf` reporting every click as
  // 'none' would read as a participant who could not hit anything.
  let cfg = {
    app: null,
    screens: [],
    content: () => document.querySelector('.wrap'),
    currentStep: () => null,
    currentOverlay: () => null,
    onAppScreen: () => true,
    overlayActive: () => false,
    hitOf: () => 'none',
    taskId: () => null,
    gazeState: () => null,
    studyMode: () => null
  };

  let PREVIEW_MODE = false;
  let TRACKING_OFF = true;   // until configure() says otherwise

  let sessionId = null;
  let sessionReady = null;
  let userId = null;
  let platform = null;

  // Click ordinal per screen, counted in the browser at click time so it
  // reflects the true order the participant clicked — not the order the
  // async inserts happened to reach the database. Counts persist across
  // Back/forward within a run and reset only when a new run starts.
  let clickSeq = {};
  const resetClickSeq = () => { clickSeq = {}; };
  const bump = step => (clickSeq[step] = (clickSeq[step] || 0) + 1);

  function newId() {
    // crypto.randomUUID needs a secure context; fall back where it isn't.
    try { return crypto.randomUUID(); }
    catch {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
    }
  }

  function getOrCreateUserId() {
    // localStorage can throw outright (private mode, blocked storage).
    // Losing persistence is fine; crashing the app is not.
    //
    // Deliberately NOT namespaced per app: the same person meeting both
    // studies is the same participant, and a second key would report them
    // as two — losing exactly the repeat-visitor fact worth having.
    const key = 'idc_hci_user_id';
    try {
      let id = localStorage.getItem(key);
      if (!id) {
        id = newId();
        localStorage.setItem(key, id);
      }
      return id;
    } catch {
      return newId();
    }
  }

  function detectPlatform() {
    const ua = navigator.userAgent || '';
    const isTouchMac = /Mac/i.test(navigator.platform || '') && navigator.maxTouchPoints > 1;
    const isMobile = /Android|iPhone|iPad|iPod|Mobile|Windows Phone/i.test(ua) || isTouchMac;
    return isMobile ? 'mobile' : 'desktop';
  }

  // Selections and clicks reference a session row, so that row has to
  // exist first. begin() keeps the in-flight insert as a promise and every
  // later write waits on it — no ordering races, no orphans.
  function begin(isRestart) {
    sessionId = newId();
    resetClickSeq();
    if (TRACKING_OFF || !window.supabaseClient) {
      sessionReady = Promise.resolve();
      return sessionReady;
    }
    sessionReady = supabaseClient.from('sessions')
      .insert({
        session_id: sessionId,
        user_id: userId,
        // Stated rather than left to the column default, so the default can
        // be dropped and a missing app becomes a failed insert instead of a
        // row quietly filed under the wrong study.
        app: cfg.app,
        platform,
        is_restart: isRestart,
        gaze_state: cfg.gazeState(),
        study_mode: cfg.studyMode()
      })
      .then(({ error }) => { if (error) console.error('startSession failed', error); })
      .catch(err => console.error('startSession failed', err));
    return sessionReady;
  }

  // Capture the ids at call time: a restart swaps both sessionId and
  // sessionReady, and a write already in flight must keep its own pair.
  async function write(table, row) {
    if (TRACKING_OFF || !window.supabaseClient) return;
    const sid = sessionId, ready = sessionReady;
    try {
      await ready;
      const { error } = await supabaseClient.from(table).insert({ session_id: sid, ...row });
      if (error) console.error(`insert into ${table} failed`, error);
    } catch (err) {
      console.error(`insert into ${table} failed`, err);
    }
  }

  // ------------------------------------------------------------------
  // Clicks
  //
  // Capture phase: runs before any button's own handler mutates state, so
  // the logged screen always reflects where the click landed rather than
  // where it took the participant.
  // ------------------------------------------------------------------
  function installClickLogger() {
    document.addEventListener('click', (e) => {
      // Consent and calibration clicks are not study behaviour. They happen
      // over the app while the current screen still reads as the first one,
      // so without this guard a run of calibration clicks lands in that
      // screen's heatmap and every one of them scores as a mis-click.
      if (cfg.overlayActive()) return;

      // Question screens are not the app. Their clicks were being written
      // as clicks on the first step, every one scoring as a mis-click
      // because a question option is not one of the app's targets.
      if (!cfg.onAppScreen()) return;

      // Anchor to the app's own content box, not the viewport. That box has
      // an identical layout everywhere, while the surrounding margins vary
      // hugely with window size — so box-relative coordinates are the only
      // ones that mean the same thing on a phone, a laptop, and the
      // dashboard's small preview.
      //
      // Values intentionally fall outside 0-1 for clicks in the margins
      // (negative above/left, >1 below/right). The dashboard maps them onto
      // the preview's own box, so they stay in the right place instead of
      // being clamped to an edge.
      const box = cfg.content();
      if (!box) return;
      const rect = box.getBoundingClientRect();
      // A zero-sized box (hidden tab, not yet laid out) would divide by zero
      // and store Infinity/NaN. Nothing meaningful to record — skip.
      if (!rect.width || !rect.height) return;

      const step = cfg.currentStep();
      if (!step) return;

      // What the click actually landed on. Recorded here, where the answer
      // is certain, rather than derived later from click counts — Back and
      // Start over do something useful without being selections, so any
      // count-based guess would misreport them as mis-clicks.
      // Guard the target: closest() only exists on Elements, and a click can
      // report a non-Element target. Throwing here would drop the click
      // entirely — losing exactly the mis-click we are trying to measure.
      const t = e.target instanceof Element ? e.target : null;
      const hit = t ? (cfg.hitOf(t) || 'none') : 'none';

      write('clicks', {
        step,
        // Which layer the coordinate belongs to. An overlay is drawn on top
        // of a screen, so without this a tap on an opened photo is painted
        // onto the grid underneath it.
        overlay: cfg.currentOverlay(),
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
        seq: bump(step),
        hit,
        // Stamped with the task in progress so two route tasks that both
        // pass through one screen do not share a heatmap. Null in free play.
        task_id: cfg.taskId()
      });
    }, true);
  }

  // ------------------------------------------------------------------
  // Set-up. Called once, by the app, before anything else here is used.
  // ------------------------------------------------------------------
  function configure(options) {
    cfg = { ...cfg, ...options };

    // An app declares its own screens; a previewStep it does not recognise
    // is not a preview, it is a typo, and treating it as one would silently
    // put a live participant's session into a non-recording mode.
    PREVIEW_MODE = !!PREVIEW_STEP && cfg.screens.includes(PREVIEW_STEP);
    TRACKING_OFF = PREVIEW_MODE || AUTHOR_MODE || QUESTION_PREVIEW;

    userId = getOrCreateUserId();
    platform = detectPlatform();
    sessionId = newId();
    resetClickSeq();

    if (!TRACKING_OFF) installClickLogger();
    return api;
  }

  const api = {
    configure,
    begin,
    write,
    newId,
    resetClickSeq,

    // Read as properties rather than copied at import time: begin() swaps
    // the session id, and a destructured copy would keep writing rows
    // against the attempt the participant has already abandoned.
    get sessionId()  { return sessionId; },
    get sessionReady() { return sessionReady; },
    get userId()     { return userId; },
    get platform()   { return platform; },
    get app()        { return cfg.app; },

    get PREVIEW_MODE()     { return PREVIEW_MODE; },
    get PREVIEW_STEP()     { return PREVIEW_STEP; },
    get TRACKING_OFF()     { return TRACKING_OFF; },
    AUTHOR_MODE,
    QUESTION_PREVIEW,
    DEBUG
  };

  return api;
})();
