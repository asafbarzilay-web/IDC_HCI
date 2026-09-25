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
    studyMode: () => null,

    // ---- the task battery's hooks ----------------------------------
    // Where the battery draws. An app that supplies neither slot simply
    // never shows a task, which is what an app that cannot run one should
    // do — see `runsTasks` in the dashboard's APPS manifest.
    slots: {},
    // Put the app back to a clean state for a fresh route attempt, landing
    // on `entryStep` if the task named one — otherwise the app's own true
    // first screen. An app ignoring the argument still resets correctly;
    // it just always lands at the beginning, the old behaviour.
    resetApp: (entryStep) => {},
    // 'app' | 'question' | 'done'. Lets the app hide its own chrome —
    // a Back button belongs to the app, not to the question over it.
    chrome: () => {},
    // Has this attempt run out of road? True for a linear flow that has
    // reached its last step. An app whose screens form a graph has no such
    // moment and should leave this false: its participants keep going
    // until they match the route or give up.
    attemptExhausted: () => false,
    // Where to leave someone whose attempt was wrong but not over.
    onRetry: () => {},
    // What to shut down when they say they are finished. Returns the label
    // for the button to settle on, so the app owns the wording too.
    onFinish: async () => 'Thanks'
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


  // ==================================================================
  // Task battery
  //
  // A study is an ordered list of things asked of a participant. Some are
  // questions, some are "do this in the app" — they differ in how they are
  // answered and scored, not in how they are sequenced, so one runner
  // walks the lot.
  //
  // With no sequenced tasks the app behaves exactly as it always did:
  // free play, no prompts. A study that has not been designed yet should
  // not present participants with an empty one.
  //
  // Lives here rather than in either app because none of it is about a
  // particular app: the five things it cannot work out for itself are the
  // hooks above.
  // ==================================================================

  const slot = (name) => {
    const f = cfg.slots && cfg.slots[name];
    return f ? f() : null;
  };

  // The battery brings its own styling, so an app gets the question types
  // by asking for them rather than by copying 170 lines of CSS. Colours are
  // variables with the shapes app's palette as the default, so that app
  // looks exactly as it did and any other app can restate them.
  const TASK_CSS = ":root {\n  --task-accent: #C15F3C;\n  --task-accent-hover: #C9A491;\n  --task-accent-soft: #F6E9E1;\n  --task-accent-line: #E4CDBE;\n  --task-warn: #A94E2E;\n  --task-surface: #FAF9F5;\n  --task-surface-hi: #FFFFFF;\n  --task-line: #E0DBCE;\n  --task-line-soft: #D8D3C6;\n  --task-ink: #29261F;\n  --task-ink-2: #5C574C;\n  --task-ink-3: #6B665A;\n  --task-muted: #8A8578;\n  --task-muted-2: #8A7C6A;\n}\n  /* ---- Task battery ---------------------------------------------- */\n  .task-banner {\n    background: var(--task-accent-soft);\n    border: 1px solid var(--task-accent-line);\n    border-radius: 12px;\n    padding: 14px 18px;\n    margin-bottom: 28px;\n    animation: flowIn 0.4s ease both;\n  }\n  .task-banner .eyebrow { margin-bottom: 4px; }\n  .task-banner p { margin: 0; font-size: 15px; line-height: 1.5; color: var(--task-ink); }\n\n\n  .task-banner-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }\n  /* Always on screen during a route task. A task that only ends on success\n     needs a way out, or someone who cannot find it is simply stuck. */\n  .task-giveup {\n    font: inherit;\n    font-size: 12px;\n    color: var(--task-muted-2);\n    background: none;\n    border: none;\n    padding: 0;\n    cursor: pointer;\n    text-decoration: underline;\n    white-space: nowrap;\n  }\n  .task-giveup:hover { color: var(--task-warn); }\n\n  .task-retry {\n    margin-top: 12px;\n    padding-top: 12px;\n    border-top: 1px solid var(--task-accent-line);\n    font-size: 14px;\n    color: var(--task-warn);\n  }\n\n  .q-block { animation: flowIn 0.4s ease both; }\n  .q-block h1 {\n    font-family: 'Newsreader', Georgia, serif;\n    font-size: 30px;\n    font-weight: 500;\n    margin: 0 0 10px;\n    letter-spacing: -0.01em;\n  }\n  .q-block .q-desc { margin: 0 0 24px; font-size: 15px; line-height: 1.6; color: var(--task-ink-2); }\n\n  .q-options { display: flex; flex-direction: column; gap: 10px; }\n  .q-option {\n    display: flex;\n    align-items: center;\n    gap: 12px;\n    text-align: left;\n    font: inherit;\n    font-size: 16px;\n    background: var(--task-surface);\n    border: 1px solid var(--task-line);\n    border-radius: 12px;\n    padding: 15px 18px;\n    cursor: pointer;\n    transition: all 0.15s ease;\n    color: var(--task-ink);\n  }\n  .q-option:hover { border-color: var(--task-accent-hover); }\n  .q-option.on { border-color: var(--task-accent); background: var(--task-accent-soft); }\n  .q-option .mark {\n    width: 19px; height: 19px; flex: none;\n    border: 1.5px solid var(--task-accent-hover);\n    background: var(--task-surface-hi);\n  }\n  .q-option .mark.radio { border-radius: 50%; }\n  .q-option .mark.box   { border-radius: 5px; }\n  .q-option.on .mark { border-color: var(--task-accent); background: var(--task-accent); box-shadow: inset 0 0 0 3px var(--task-surface); }\n  .q-option input.other-text {\n    flex: 1; font: inherit; font-size: 15px;\n    border: none; border-bottom: 1px solid var(--task-line-soft);\n    background: transparent; padding: 2px 0; color: var(--task-ink);\n  }\n  .q-option input.other-text:focus { outline: none; border-bottom-color: var(--task-accent); }\n\n  .q-scale-wrap { display: inline-block; max-width: 100%; }\n  .q-scale { display: flex; gap: 8px; flex-wrap: wrap; }\n  .q-scale button {\n    font: inherit; font-size: 17px;\n    min-width: 52px; height: 52px;\n    border: 1px solid var(--task-line);\n    background: var(--task-surface);\n    border-radius: 10px;\n    cursor: pointer;\n    color: var(--task-ink);\n    transition: all 0.15s ease;\n  }\n  .q-scale button:hover { border-color: var(--task-accent-hover); }\n  .q-scale button.on { border-color: var(--task-accent); background: var(--task-accent); color: var(--task-surface); }\n  .q-scale.faces button, .q-scale.stars button { font-size: 24px; }\n  .q-scale.stars button.on { background: var(--task-surface); color: var(--task-accent); border-color: var(--task-accent); }\n\n  .q-scale-labels {\n    display: flex; justify-content: space-between;\n    margin-top: 10px; font-size: 12px; color: var(--task-muted); gap: 12px;\n  }\n  .q-scale-labels span:nth-child(2) { text-align: center; }\n  .q-scale-labels span:last-child { text-align: right; }\n\n\n  /* Yes/No: two large targets rather than a list, because a binary answer\n     should not look like a list that happens to have two entries. */\n  .q-binary { display: flex; gap: 14px; flex-wrap: wrap; }\n  .q-binary button {\n    flex: 1 1 160px;\n    font: inherit;\n    background: var(--task-surface);\n    border: 1px solid var(--task-line);\n    border-radius: 14px;\n    padding: 26px 18px;\n    cursor: pointer;\n    transition: all 0.15s ease;\n    display: flex; flex-direction: column; align-items: center; gap: 10px;\n  }\n  .q-binary button:hover { border-color: var(--task-accent-hover); }\n  .q-binary button.on { border-color: var(--task-accent); background: var(--task-accent-soft); }\n  .q-binary .glyph { font-size: 30px; line-height: 1; }\n  .q-binary .word { font-size: 17px; color: var(--task-ink); }\n\n  /* Matrix: a grid on anything with room, a stack of small groups when\n     there is not \u2014 a grid squeezed onto a phone is unreadable either way. */\n  .q-matrix { width: 100%; border-collapse: collapse; }\n  .q-matrix th, .q-matrix td { padding: 10px 8px; text-align: center; }\n  .q-matrix th { font-size: 12px; font-weight: 500; color: var(--task-ink-3); }\n  .q-matrix th.stmt, .q-matrix td.stmt {\n    text-align: left; font-size: 15px; color: var(--task-ink); width: 40%;\n  }\n  .q-matrix tbody tr:nth-child(odd) { background: var(--task-surface); }\n  .q-matrix tbody tr td:first-child { border-radius: 8px 0 0 8px; }\n  .q-matrix tbody tr td:last-child { border-radius: 0 8px 8px 0; }\n  .q-cell { width: 20px; height: 20px; border: 1.5px solid var(--task-accent-hover); background: #FFF; cursor: pointer; display: inline-block; }\n  .q-cell.radio { border-radius: 50%; }\n  .q-cell.box { border-radius: 5px; }\n  .q-cell.on { border-color: var(--task-accent); background: var(--task-accent); box-shadow: inset 0 0 0 3px var(--task-surface); }\n\n  .q-matrix-stack .stack-group { margin-bottom: 18px; }\n  .q-matrix-stack .stack-stmt { font-size: 15px; color: var(--task-ink); margin-bottom: 8px; }\n\n  .q-input {\n    width: 100%; font: inherit; font-size: 17px;\n    padding: 14px 16px; border: 1px solid var(--task-line); border-radius: 12px;\n    background: var(--task-surface); color: var(--task-ink);\n  }\n  .q-input:focus { outline: none; border-color: var(--task-accent); background: #FFF; }\n  .q-input-note { font-size: 12px; color: var(--task-muted); margin-top: 8px; }\n\n  .q-actions { margin-top: 30px; display: flex; align-items: center; gap: 14px; }\n  .q-continue {\n    font: inherit; font-size: 15px;\n    background: var(--task-accent); color: var(--task-surface);\n    border: none; border-radius: 10px;\n    padding: 12px 26px; cursor: pointer;\n    transition: background 0.2s ease;\n  }\n  .q-continue:hover:not(:disabled) { background: var(--task-warn); }\n  .q-continue:disabled { opacity: 0.4; cursor: default; }\n  .q-skip {\n    font: inherit; font-size: 14px; color: var(--task-muted);\n    background: none; border: none; cursor: pointer; text-decoration: underline;\n  }\n  .q-skip:hover { color: var(--task-ink); }\n\n";

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected || !document.head) return;
    stylesInjected = true;
    const el = document.createElement('style');
    el.id = 'study-task-css';
    el.textContent = TASK_CSS;
    // Prepended, not appended: the app's own stylesheet must be able to
    // override these without needing !important on every rule.
    document.head.insertBefore(el, document.head.firstChild);
  }

  let battery = [];
  let studyMode = 'tasks';
  // Latest value chosen on each screen. The route is scored against this
  // rather than against app state, so the core never needs to know what a
  // screen of a given app actually contains.
  let answers = {};
  let taskIndex = -1;
  let taskStartedAt = 0;
  let routeAttempt = [];      // every pick made during the current route task
  let routeAttempts = 1;      // how many times they have run the flow for it
  let routeRetry = false;     // show the "not the one" note on this pass

  const currentTask = () => (taskIndex >= 0 ? battery[taskIndex] : null);
  const inBattery = () => !!currentTask();

  // Whether the app itself is what is on screen. A question renders into
  // the app's own container without changing which screen the app thinks
  // it is on, so without this the app keeps cheerfully reporting its first
  // screen while the participant reads a question — and every click logged
  // against that name lands on a screen they never saw.
  const onAppScreen = () => {
    const t = currentTask();
    return !t || t.kind === 'app_route';
  };

  // Read before the session row is written, so the session can record the
  // mode it actually ran under. Falls back to 'tasks', which is how the
  // app behaved before modes existed.
  async function loadStudyMode() {
    if (TRACKING_OFF || !window.supabaseClient) return 'tasks';
    try {
      const { data, error } = await supabaseClient
        .from('study_settings').select('mode').eq('app', cfg.app).maybeSingle();
      if (error || !data) return 'tasks';
      return data.mode || 'tasks';
    } catch { return 'tasks'; }
  }

  async function loadBattery() {
    if (TRACKING_OFF || !window.supabaseClient) return [];
    try {
      const { data, error } = await supabaseClient
        .from('tasks')
        .select('task_id, kind, name, goal_text, config, path, binding, entry_step, position')
        // Without this the two studies' batteries interleave by position
        // and a participant is handed a route through an app they cannot see.
        .eq('app', cfg.app)
        .not('position', 'is', null)
        // Belt and braces: hiding already takes a task out of the list the
        // dashboard can sequence, but a hidden task must never reach a
        // participant even if one somehow keeps a position.
        .eq('hidden', false)
        .order('position', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) { console.warn('Could not load the task sequence:', error); return []; }
      return data || [];
    } catch (err) {
      // A study that cannot load its tasks falls back to free play rather
      // than showing a broken screen: analytics must never break the app.
      console.warn('Could not load the task sequence:', err);
      return [];
    }
  }

  function recordResponse(answer) {
    const t = currentTask();
    if (!t) return;
    write('task_responses', {
      task_id: t.task_id,
      kind: t.kind,
      answer,
      duration_ms: Math.max(0, Date.now() - taskStartedAt)
    });
  }

  function nextTask() {
    taskIndex += 1;
    if (taskIndex >= battery.length) { renderBatteryDone(); return; }
    renderTask();
  }

  // One dot per task, so the rail answers "how much of this is left" —
  // the only progress question a participant actually has. The selector's
  // own three steps are already obvious from the headings, and showing
  // both positions at once ("Task 1 of 4 · Step 1 of 3") read as noise.
  function renderBatteryProgress() {
    const rail = slot('progress');
    if (!rail) return;
    const dots = battery.map((_, i) =>
      `<div class="progress-dot${i <= taskIndex ? ' active' : ''}"></div>`).join('');
    rail.innerHTML = dots
      + '<div class="progress-spacer"></div>'
      + `<div class="progress-label" id="progress-label">Task ${Math.min(taskIndex + 1, battery.length)} of ${battery.length}</div>`;
  }

  function renderTask() {
    const t = currentTask();
    taskStartedAt = Date.now();
    renderBatteryProgress();

    if (t.kind === 'app_route') {
      // Each route task is its own fresh attempt at the app.
      routeAttempt = [];
      routeAttempts = 1;
      routeRetry = false;
      answers = {};
      resetClickSeq();
      cfg.chrome('app');
      // A task can name where it begins — the demonstrated step marked as
      // the start — so a participant is not forced through screens the
      // task deliberately isn't testing (login, to reach chat). Steps
      // before that entry point were never bound (see the dashboard's
      // authoring UI), so scoring is unaffected either way.
      cfg.resetApp(t.entry_step || null);
      return;
    }

    cfg.chrome('question');
    renderQuestion(t);
  }

  // --- question rendering ------------------------------------------------
  // An eleven-point ramp, sampled evenly for whatever scale length is in
  // use. Five faces stretched over seven steps repeated two of them, so
  // adjacent buttons looked identical and the scale read as broken.

  // ------------------------------------------------------------------
  // Route scoring
  //
  // Checked after EVERY choice rather than only when a flow reaches its
  // last step. For a linear app the two are identical — you cannot match
  // three bound steps before answering three. For an app whose screens
  // form a graph there is no last step at all, so "the bound answers are
  // all correct now" is the only rule that works for both.
  // ------------------------------------------------------------------
  // Returns true when it changed what is on screen — advanced to the next
  // task, or put the participant back to retry. The app uses that to decide
  // whether to render: rendering anyway would paint the app over a question
  // the battery had just drawn in the same container.
  function considerRoute() {
    const t = currentTask();
    if (!t || t.kind !== 'app_route') return false;

    // Scored on the bound steps only. Wandering through free steps is not
    // failure — it shows up as extra time and clicks instead.
    const bound = t.binding || [];
    const wanted = Object.fromEntries((t.path || []).map(p => [p.step, p.value]));
    // An empty binding would make every attempt wrong and trap the
    // participant in a task they cannot finish, so it counts as reached.
    const matched = bound.length === 0 || bound.every(s => answers[s] === wanted[s]);

    if (matched) { finishRouteTask('reached'); return true; }

    // Not the goal, and the app says this attempt has run out of road.
    // Advancing to the next task is the only confirmation they get, so not
    // advancing is the signal — but they are left exactly where they are
    // rather than sent back to the start. No real app restarts you, and
    // Back is the recovery path worth observing: wiping their answers
    // would replace it with a mechanism that only exists in the test.
    //
    // An app with no natural end to an attempt never reports exhausted,
    // and its participants simply keep going until they match or give up.
    if (cfg.attemptExhausted()) {
      routeAttempts += 1;
      routeRetry = true;
      cfg.onRetry();
      return true;
    }
    return false;
  }

  // The single exit from a route task: either they reached the goal or they
  // stopped trying. Both are results; only one of them is success.
  function finishRouteTask(how) {
    const t = currentTask();
    if (!t) return;

    // Changing an answer within an attempt, or needing more than one
    // attempt, both mean they got there but not straight away.
    const seen = {};
    routeAttempt.forEach(p => { seen[p.step] = (seen[p.step] || 0) + 1; });
    const revisited = Object.values(seen).some(n => n > 1);
    const firstTime = routeAttempts === 1 && !revisited;

    recordResponse({
      // Every pick across every attempt, in order.
      trail: routeAttempt.slice(),
      final: Object.entries(answers).map(([step, value]) => ({ step, value })),
      attempts: routeAttempts,
      revisited,
      matched: how === 'reached',
      completed: how === 'reached',
      outcome: how === 'gave_up' ? 'gave_up' : (firstTime ? 'direct' : 'indirect')
    });
    nextTask();
  }
  // Sampling always keeps both extremes and never repeats up to 11 steps.
  const FACE_RAMP = ['😩', '😖', '😟', '🙁', '😕', '😐', '🙂', '😊', '😄', '😁', '🤩'];
  const faceFor = (i, steps) => steps <= 1
    ? FACE_RAMP[FACE_RAMP.length - 1]
    : FACE_RAMP[Math.round(i * (FACE_RAMP.length - 1) / (steps - 1))];

  function renderQuestion(t, opts = {}) {
    const c = t.config || {};
    const host = slot('question');
    if (!host) return;
    const desc = c.description ? `<p class="q-desc">${escapeHtml(c.description)}</p>` : '';
    const body = QUESTION_BODY[t.kind] ? QUESTION_BODY[t.kind](c) : choiceMarkup(c);

    host.innerHTML = `
      <div class="q-block">
        <h1>${escapeHtml(t.goal_text)}</h1>
        ${desc}
        ${body}
        <div class="q-actions">
          <button class="q-continue" id="q-continue" disabled>Continue</button>
          ${c.required === false ? '<button class="q-skip" id="q-skip">Skip this question</button>' : ''}
        </div>
      </div>`;

    const answer = (QUESTION_WIRE[t.kind] || wireChoices)(c);
    const cont = document.getElementById('q-continue');

    // A preview is interactive so you can see the selected state, but it
    // must not advance anything: there is no battery behind it.
    if (opts.preview) {
      cont.disabled = false;
      answer.onChange(() => {});
      return;
    }

    // Required means required: Continue stays dead until something is
    // chosen, rather than letting an empty answer through as if it were one.
    answer.onChange(ok => { cont.disabled = c.required === false ? false : !ok; });
    if (c.required === false) cont.disabled = false;

    cont.addEventListener('click', () => { recordResponse(answer.value()); nextTask(); });
    const skip = document.getElementById('q-skip');
    if (skip) skip.addEventListener('click', () => { recordResponse({ skipped: true }); nextTask(); });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, ch => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  // Shuffled per participant when asked for, so a choice's position cannot
  // quietly shape how often it is picked. The order shown is recorded with
  // the answer, or the shuffle would make the result unreadable later.
  function shuffled(list) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function choiceMarkup(c) {
    const opts = c.shuffle ? shuffled(c.choices || []) : (c.choices || []);
    window.__shownOrder = opts;
    const mark = c.select === 'multi' ? 'box' : 'radio';
    const rows = opts.map((o, i) =>
      `<button type="button" class="q-option" data-v="${escapeHtml(o)}">
         <span class="mark ${mark}"></span>${escapeHtml(o)}</button>`).join('');
    const other = c.other
      ? `<button type="button" class="q-option" data-other="1">
           <span class="mark ${mark}"></span>
           <input class="other-text" placeholder="Something else…"></button>` : '';
    const optOut = c.opt_out
      ? `<button type="button" class="q-option" data-optout="1">
           <span class="mark ${mark}"></span>None of these apply</button>` : '';
    return `<div class="q-options">${rows}${other}${optOut}</div>`;
  }

  function wireChoices(c) {
    const multi = c.select === 'multi';
    const host = document.querySelector('.q-options');
    let cb = () => {};

    host.addEventListener('click', (e) => {
      const btn = e.target.closest('.q-option');
      if (!btn) return;
      // Typing in the 'other' field should not toggle the row off again.
      if (e.target.classList.contains('other-text')) { btn.classList.add('on'); cb(true); return; }

      // "None of these apply" contradicts every other answer, so the two
      // cannot both stand. Picking either one clears the other.
      const optOut = host.querySelector('[data-optout]');
      if (btn.dataset.optout) {
        const turningOn = !btn.classList.contains('on');
        host.querySelectorAll('.q-option').forEach(b => b.classList.remove('on'));
        btn.classList.toggle('on', turningOn);
        cb(!!host.querySelector('.q-option.on'));
        return;
      }
      if (optOut) optOut.classList.remove('on');

      if (multi) btn.classList.toggle('on');
      else host.querySelectorAll('.q-option').forEach(b => b.classList.toggle('on', b === btn));
      if (btn.dataset.other) btn.querySelector('.other-text').focus();
      cb(!!host.querySelector('.q-option.on'));
    });

    return {
      onChange: fn => { cb = fn; },
      value: () => {
        const on = [...host.querySelectorAll('.q-option.on')];
        return {
          selected: on.filter(b => !b.dataset.other && !b.dataset.optout).map(b => b.dataset.v),
          other: on.some(b => b.dataset.other)
            ? (host.querySelector('.other-text').value.trim() || null) : null,
          opted_out: on.some(b => b.dataset.optout),
          // What they were actually shown, in the order they saw it.
          shown_order: window.__shownOrder
        };
      }
    };
  }

  function scaleMarkup(c) {
    const steps = c.steps || 10;
    const start = c.start_at_one === false ? 0 : 1;
    const display = c.display || 'number';
    const vals = Array.from({ length: steps }, (_, i) => start + i);
    const label = (v, i) => display === 'stars' ? '★'
                         : display === 'emotions' ? faceFor(i, steps) : v;
    const buttons = vals.map((v, i) =>
      `<button type="button" data-v="${v}">${label(v, i)}</button>`).join('');
    const L = c.labels || {};
    const labels = (L.left || L.mid || L.right)
      ? `<div class="q-scale-labels"><span>${escapeHtml(L.left || '')}</span>`
        + `<span>${escapeHtml(L.mid || '')}</span><span>${escapeHtml(L.right || '')}</span></div>` : '';
    // Wrapped so the labels are as wide as the buttons they describe.
    // Spanning the container instead put "great" a long way right of the
    // highest rating, which reads as a different scale entirely.
    return `<div class="q-scale-wrap"><div class="q-scale ${display}">${buttons}</div>${labels}</div>`;
  }

  function wireScale(c) {
    const host = document.querySelector('.q-scale');
    let cb = () => {}, picked = null;
    host.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      picked = Number(b.dataset.v);
      // Stars read as a filled run up to the choice; numbers and faces
      // are a single pick, because "7 out of 10" is not seven things.
      const all = [...host.querySelectorAll('button')];
      all.forEach((x, i) => x.classList.toggle('on',
        (c.display || 'number') === 'stars' ? i <= all.indexOf(b) : x === b));
      cb(true);
    });
    return {
      onChange: fn => { cb = fn; },
      value: () => ({ rating: picked, steps: c.steps || 10,
                      start_at: c.start_at_one === false ? 0 : 1, display: c.display || 'number' })
    };
  }


  // --- Yes / No ----------------------------------------------------------
  function yesNoMarkup(c) {
    const emo = c.display === 'emotions';
    const opt = (v, glyph, word) =>
      `<button type="button" data-v="${v}"><span class="glyph">${glyph}</span><span class="word">${word}</span></button>`;
    return `<div class="q-binary">
      ${opt('yes', emo ? '🙂' : '✓', 'Yes')}
      ${opt('no',  emo ? '🙁' : '✗', 'No')}
    </div>`;
  }

  function wireYesNo() {
    const host = document.querySelector('.q-binary');
    let cb = () => {}, picked = null;
    host.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      picked = b.dataset.v;
      host.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      cb(true);
    });
    return { onChange: fn => { cb = fn; }, value: () => ({ choice: picked }) };
  }

  // --- Matrix ------------------------------------------------------------
  // Statements down the side, one shared set of choices across the top.
  function matrixMarkup(c) {
    const statements = c.shuffle_statements ? shuffled(c.statements || []) : (c.statements || []);
    const choices = c.shuffle_choices ? shuffled(c.choices || []) : (c.choices || []);
    // Recorded with the answer: shuffled order is unreadable afterwards
    // without knowing what order it was.
    window.__matrixOrder = { statements, choices };
    const mark = c.select === 'multi' ? 'box' : 'radio';

    // A grid needs horizontal room per choice. Below that it stops being
    // a grid you can read and becomes one you have to decode.
    const stack = c.optimize_small && window.innerWidth < 620;

    const optOut = c.opt_out
      ? `<div class="q-options" style="margin-top:14px">
           <button type="button" class="q-option" data-optout="1">
             <span class="mark ${mark}"></span>None of these apply</button>
         </div>` : '';

    if (stack) {
      return `<div class="q-matrix-stack">
        ${statements.map(st => `
          <div class="stack-group" data-stmt="${escapeHtml(st)}">
            <div class="stack-stmt">${escapeHtml(st)}</div>
            <div class="q-options">
              ${choices.map(ch => `
                <button type="button" class="q-option" data-stmt="${escapeHtml(st)}" data-v="${escapeHtml(ch)}">
                  <span class="mark ${mark}"></span>${escapeHtml(ch)}</button>`).join('')}
            </div>
          </div>`).join('')}
        ${optOut}</div>`;
    }

    return `<table class="q-matrix">
      <thead><tr><th class="stmt"></th>
        ${choices.map(ch => `<th>${escapeHtml(ch)}</th>`).join('')}</tr></thead>
      <tbody>
        ${statements.map(st => `<tr data-stmt="${escapeHtml(st)}">
          <td class="stmt">${escapeHtml(st)}</td>
          ${choices.map(ch => `<td>
            <span class="q-cell ${mark}" data-stmt="${escapeHtml(st)}" data-v="${escapeHtml(ch)}"></span>
          </td>`).join('')}
        </tr>`).join('')}
      </tbody></table>${optOut}`;
  }

  function wireMatrix(c) {
    const multi = c.select === 'multi';
    const statements = (window.__matrixOrder || {}).statements || c.statements || [];
    const host = slot('question');
    let cb = () => {};
    const picked = {};      // statement -> Set of choices
    let optedOut = false;

    const ready = () => optedOut
      || statements.every(st => picked[st] && picked[st].size);

    host.addEventListener('click', (e) => {
      const out = e.target.closest('[data-optout]');
      if (out) {
        optedOut = !optedOut;
        out.classList.toggle('on', optedOut);
        // Opting out and answering rows are mutually exclusive claims.
        if (optedOut) {
          Object.keys(picked).forEach(k => delete picked[k]);
          host.querySelectorAll('.q-cell.on, .q-option.on').forEach(x => {
            if (!x.dataset.optout) x.classList.remove('on');
          });
        }
        cb(ready());
        return;
      }

      const cell = e.target.closest('[data-stmt][data-v]');
      if (!cell) return;
      if (optedOut) {
        optedOut = false;
        const o = host.querySelector('[data-optout]');
        if (o) o.classList.remove('on');
      }
      const st = cell.dataset.stmt, v = cell.dataset.v;
      picked[st] = picked[st] || new Set();

      if (multi) {
        picked[st].has(v) ? picked[st].delete(v) : picked[st].add(v);
        cell.classList.toggle('on');
      } else {
        picked[st].clear(); picked[st].add(v);
        host.querySelectorAll(`[data-stmt="${CSS.escape(st)}"][data-v]`)
          .forEach(x => x.classList.toggle('on', x === cell));
      }
      cb(ready());
    });

    return {
      onChange: fn => { cb = fn; },
      value: () => ({
        rows: Object.fromEntries(Object.entries(picked).map(([k, v]) => [k, [...v]])),
        opted_out: optedOut,
        shown_order: window.__matrixOrder
      })
    };
  }

  // --- Simple input ------------------------------------------------------
  function inputMarkup(c) {
    const type = c.input_type || 'text';
    const ph = { text: 'Type your answer here', number: 'Enter a number',
                 date: '', email: 'name@example.com' }[type] || '';
    return `<input class="q-input" id="q-free-input" type="${type}" placeholder="${ph}">`
      + (type === 'email' ? '<div class="q-input-note">We only use this to identify your answers.</div>' : '');
  }

  function wireInput(c) {
    const el = document.getElementById('q-free-input');
    let cb = () => {};
    // Browser validity covers the shape of an email or a number; empty is
    // handled separately so a blank field never counts as an answer.
    const ok = () => el.value.trim() !== '' && el.checkValidity();
    el.addEventListener('input', () => cb(ok()));
    return {
      onChange: fn => { cb = fn; },
      value: () => ({ value: el.value.trim(), input_type: c.input_type || 'text' })
    };
  }

  const QUESTION_BODY = {
    multiple_choice: choiceMarkup,
    opinion_scale: scaleMarkup,
    yes_no: yesNoMarkup,
    matrix: matrixMarkup,
    simple_input: inputMarkup
  };

  const QUESTION_WIRE = {
    multiple_choice: wireChoices,
    opinion_scale: wireScale,
    yes_no: wireYesNo,
    matrix: wireMatrix,
    simple_input: wireInput
  };

  function renderBatteryDone() {
    const rail = slot('progress');
    if (rail) {
      rail.innerHTML = battery.map(() => '<div class="progress-dot active"></div>').join('')
        + '<div class="progress-spacer"></div>'
        + '<div class="progress-label" id="progress-label">Complete</div>';
    }
    taskIndex = battery.length;   // out of range: inBattery() is false again
    cfg.chrome('done');
    const host = slot('question');
    if (!host) return;
    host.innerHTML = `
      <div class="success">
        <div class="success-badge">
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="#F0EEE6" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        </div>
        <h1>All done</h1>
        <p class="success-copy">Thank you — that is everything we needed.</p>
        <div class="success-actions">
          <button class="restart-btn" id="done-btn">I'm done</button>
        </div>
      </div>`;
    wireDoneButton();
  }

  // Whatever the app needs to shut down when a participant says they are
  // finished. The shapes app has a camera to switch off and says so; the
  // photo app has nothing, and a button claiming otherwise would be telling
  // a participant about hardware that was never on.
  //
  // cfg.onFinish() returns the label to settle on, so the app owns both the
  // side effect and the wording for it.
  function wireDoneButton() {
    const btn = document.getElementById('done-btn');
    if (!btn) return;
    btn.addEventListener('click', async (e) => {
      const b = e.currentTarget;
      b.disabled = true;
      b.textContent = 'Finishing…';
      let label = 'Thanks';
      try { label = (await cfg.onFinish()) || label; }
      catch (err) { console.warn('onFinish failed', err); }
      b.textContent = label;
    });
  }



  // ------------------------------------------------------------------
  // The one entry point for "the participant chose something".
  //
  // Both apps used to do these four things themselves, slightly
  // differently: write the selection, stamp it with the task in progress,
  // tell the task author, and check whether the route is now complete.
  // Doing it in one place is what lets the route model work for an app the
  // core has never seen.
  // ------------------------------------------------------------------
  function choice(step, value, durationMs) {
    const t = currentTask();

    // Append-only, and deliberately not deduplicated. Overwriting a step's
    // earlier value in place erases the fact that it was answered twice —
    // which is the whole difference between reaching the goal directly and
    // reaching it after changing your mind. Same reading rule as
    // `selections`: a step's answer is its latest entry.
    if (t && t.kind === 'app_route') routeAttempt.push({ step, value });
    answers[step] = value;

    write('selections', {
      step,
      value,
      duration_ms: Math.max(0, durationMs | 0),
      // Stamped like clicks and gaze: in free_then_tasks one session holds
      // both free play and task work, and the picks have to say which.
      task_id: t ? t.task_id : null
    });

    reportToAuthor('choice', { step, value });
    return considerRoute();
  }

  // Author mode: the dashboard embeds an app so a route task can be defined
  // by demonstration. Demonstrating is the only way a task can name a
  // screen or target that actually exists; a hand-written route drifts the
  // moment the app changes.
  function reportToAuthor(type, payload) {
    if (!AUTHOR_MODE || window.parent === window) return;
    // Same-origin only: the dashboard serves this frame, so there is no
    // reason to broadcast the study's design more widely.
    window.parent.postMessage({ source: 'idc-hci-author', type, ...payload },
                              window.location.origin);
  }

  // Read the mode, open the session, then load the battery — in that
  // order. The mode has to be known before the session row is written so
  // the row can record which mode it ran under; the battery needs a session
  // to attach its answers to, so loading it earlier would race the insert
  // it depends on.
  async function startStudy({ beforeSession } = {}) {
    studyMode = await loadStudyMode();
    if (beforeSession) await beforeSession();
    begin(false);
    battery = studyMode === 'free' ? [] : await loadBattery();

    if (studyMode === 'tasks' && battery.length) {
      taskIndex = -1;
      nextTask();
      return { started: true, offer: false };
    }
    // They explore first and start when they say so. The control stays on
    // screen the whole time rather than appearing at some threshold we
    // decided for them.
    return { started: false, offer: studyMode === 'free_then_tasks' && battery.length > 0 };
  }

  // The "start the tasks" control in free_then_tasks.
  function beginTasks() {
    // A clean run at the first task: free play leaves the app part way
    // through, and the task should not inherit that position.
    answers = {};
    resetClickSeq();
    taskIndex = -1;
    nextTask();
  }

  function giveUp() { finishRouteTask('gave_up'); }

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

    injectStyles();
    if (!TRACKING_OFF) installClickLogger();

    // A participating app with no client records nothing, and does it
    // silently: write() checks for the client and returns quietly, so the
    // app looks perfectly healthy while the dashboard stays empty. That
    // is a worse failure than a crash, because nothing points at it until
    // a study has already been run. Say so loudly instead.
    if (!TRACKING_OFF && !window.supabaseClient) {
      console.error(
        `Study: app '${cfg.app}' is configured to record, but no supabaseClient exists. ` +
        'Nothing will be written. Create the client before study-core.js runs.');
    }
    return api;
  }

  const api = {
    configure,
    begin,
    write,
    newId,
    resetClickSeq,
    choice,
    startStudy,
    beginTasks,
    giveUp,
    reportToAuthor,
    renderQuestion,
    currentTask,
    inBattery,
    onAppScreen,
    // Drawn by the app rather than by the battery: an app's own success
    // screen carries the done button, and its own layout carries the
    // progress rail. Exposed so neither has to be reimplemented.
    renderProgress: renderBatteryProgress,
    wireDoneButton,
    escapeHtml,
    get battery()   { return battery; },
    get studyMode() { return studyMode; },
    get taskIndex() { return taskIndex; },
    get routeRetry(){ return routeRetry; },
    get routeAttempts() { return routeAttempts; },

    // Read as properties rather than copied at import time: begin() swaps
    // the session id, and a destructured copy would keep writing rows
    // against the attempt the participant has already abandoned.
    // Where this app's measured box is on screen, right now.
    //
    // The dashboard paints click dots over a preview of the app, and it has
    // to project them onto the same box the coordinates were measured
    // against. It used to look for '.wrap' by name, which is the shapes
    // app's column and exists in no other app — so a second app's dots
    // silently fell back to being spread across the whole preview frame.
    // Asking the app itself works for any app, including ones not written
    // yet. Returns null when the box is not laid out.
    contentRect() {
      const box = cfg.content && cfg.content();
      if (!box) return null;
      const r = box.getBoundingClientRect();
      return (r.width && r.height) ? r : null;
    },

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
