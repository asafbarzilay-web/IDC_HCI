/* =====================================================================
   study-core.js — the half of a study app that is not about the app.

   Every participant app in this repo loads this file, and the set is
   expected to keep growing: each new product is one more HTML file that
   calls Study.configure() and gets the whole study platform with it. The
   dashboard's APPS manifest lists which apps exist today; nothing in here
   names one.

   What lives here, because none of it differs between products:
     - identity, the session lifecycle, and every write to Supabase,
       ordered so no row races the session row it references
     - click logging against a fixed measured box, stamped with the task
       in progress
     - the task battery: study modes, route tasks with entry points and
       their scoring (direct / indirect / gave up), and the six question
       types with their CSS
     - webcam gaze tracking: consent, calibration, fixations, and the stop
       control — one switch per app in the dashboard, off unless asked for
     - author mode, which reports a demonstrated route to the dashboard

   WHAT AN APP MUST SUPPLY (see `cfg` below): the box coordinates are
   measured against, which screen and overlay are showing, what a click
   landed on, where the battery draws, how to reset for a fresh attempt
   (optionally restoring a snapshot of state taken while authoring), which
   chrome to hide behind a question, and whether an attempt can run out of
   road. Those are the things this file cannot know for itself. Adding an
   app means answering them — see the `instrumenting-a-new-app` skill —
   not copying anything out of an existing app.
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
  // The author's test link. Skips the "already took part" check, so the
  // battery can be tried as often as needed, and marks the session as a
  // test so the dashboard leaves it out of the results.
  const RETAKE           = params.get('retake') === '1';

  // What a preview should show besides the screen id. A screen partway
  // into a flow depends on what led there — Shvil's walker page is one of
  // ten walkers — and a preview drawn with defaults paints a participant's
  // clicks on Tamar's page over Noa's. The dashboard passes either the
  // app's own snapshot for that step (`previewState`, from authoring) or,
  // for tasks saved before snapshots existed, the demonstrated choices
  // leading to it (`previewRoute`), which the app turns into state itself.
  const jsonParam = (k) => {
    try { const v = params.get(k); return v ? JSON.parse(v) : null; }
    catch { return null; }
  };
  const PREVIEW_STATE = jsonParam('previewState');
  const PREVIEW_ROUTE = jsonParam('previewRoute');

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
    // Which task a click belongs to, and the session's gaze state, are
    // not hooks any more: both are things this file already knows. As
    // hooks they were copied into each app, and two apps copied
    // `taskId: () => null` — so every click made during one of their tasks
    // was filed as free play. Anything an app still passes for them is
    // ignored.

    // ---- the task battery's hooks ----------------------------------
    // Where the battery draws. An app that supplies neither slot simply
    // never shows a task, which is what an app that cannot run one should
    // do — see `runsTasks` in the dashboard's APPS manifest.
    slots: {},
    // Put the app back to a clean state for a fresh route attempt, landing
    // on `entryStep` if the task named one — otherwise the app's own true
    // first screen. An app ignoring the argument still resets correctly;
    // it just always lands at the beginning, the old behaviour.
    //
    // `entryState` is whatever `snapshot()` returned at that step while
    // the author demonstrated, or null for a task saved without one. A
    // screen partway into a flow depends on what was picked on the way
    // (checkout needs a walker, a day and a time); restoring the author's
    // picks is what makes it the screen they meant, not a generic one.
    resetApp: (entryStep, entryState) => {},
    // The app's state as plain JSON, minus the current screen. Taken in
    // author mode with every captured choice, so a task can later start
    // partway in with that state restored. An app with no state worth
    // restoring leaves this returning null.
    snapshot: () => null,
    // The same kind of state as snapshot() returns, rebuilt from a list of
    // recorded choices [{step, value}] — the app's own vocabulary, so only
    // the app can read it. Used for previews of tasks that have no
    // snapshots. Null when the app has nothing to rebuild.
    stateFromRoute: (route) => null,
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
    // Send the abandoned attempt's buffered gaze before the session id
    // changes underneath it. flushGaze() captures the old session
    // synchronously, so no await is needed here.
    closeFixation();
    flushGaze();

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
        gaze_state: gazeState,
        study_mode: studyMode,
        // Sent only when true, so ordinary sessions still insert against a
        // database that has not had the is_test column added yet.
        ...(RETAKE ? { is_test: true } : {})
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
      if (gazeOverlayUp || transitionUp || cfg.overlayActive()) return;

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
        task_id: currentTaskId()
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
  const TASK_CSS = `
:root {
  --task-accent: #C15F3C;
  --task-accent-hover: #C9A491;
  --task-accent-soft: #F6E9E1;
  --task-accent-line: #E4CDBE;
  --task-warn: #A94E2E;
  --task-surface: #FAF9F5;
  --task-surface-hi: #FFFFFF;
  --task-line: #E0DBCE;
  --task-line-soft: #D8D3C6;
  --task-ink: #29261F;
  --task-ink-2: #5C574C;
  --task-ink-3: #6B665A;
  --task-muted: #8A8578;
  --task-muted-2: #8A7C6A;
  /* Room around a question. Apps whose question slot already sits in a
     padded column (the selector) set this to 0; a phone frame needs extra
     at the top to clear its status bar. */
  --task-q-pad: 56px 32px 48px;
  --task-q-width: 600px;
  /* Empty radio/checkbox marks: derived from the ink, not the line colour,
     because some palettes' lines are too pale to show an empty circle. */
  --task-mark: color-mix(in srgb, var(--task-ink) 28%, transparent);
}

  /* ---- Route-task banner (the selector draws it inside its column) ---- */
  .task-banner {
    background: var(--task-accent-soft);
    border: 1px solid var(--task-accent-line);
    border-radius: 12px;
    padding: 14px 18px;
    margin-bottom: 28px;
    animation: qIn 0.4s ease both;
  }
  .task-banner .eyebrow { margin-bottom: 4px; }
  .task-banner p { margin: 0; font-size: 15px; line-height: 1.5; color: var(--task-ink); }
  .task-banner-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
  /* Always on screen during a route task. A task that only ends on success
     needs a way out, or someone who cannot find it is simply stuck. */
  .task-giveup {
    font: inherit; font-size: 12px; color: var(--task-muted-2);
    background: none; border: none; padding: 0; cursor: pointer;
    text-decoration: underline; white-space: nowrap;
  }
  .task-giveup:hover { color: var(--task-warn); }
  .task-retry {
    margin-top: 12px; padding-top: 12px;
    border-top: 1px solid var(--task-accent-line);
    font-size: 14px; color: var(--task-warn);
  }

  /* ---- Questions --------------------------------------------------------
     One centred column, the same in every app: a narrow measure reads as a
     question being asked, where options stretched across a 1180px frame
     read as a form to get through. Vertically centred when the slot has a
     height of its own (Shvil's frame, photo's phone). */
  .q-block {
    box-sizing: border-box;
    width: 100%; max-width: var(--task-q-width); margin: 0 auto;
    padding: var(--task-q-pad);
    min-height: 100%;
    display: flex; flex-direction: column; justify-content: center;
    animation: qIn 0.4s ease both;
    /* Lets the layouts below respond to the room the question has — a
       375px phone inside a wide browser is narrow, whatever the window. */
    container-type: inline-size;
  }
  @keyframes qIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

  /* What kind of answer is wanted, said before the question rather than
     discovered by clicking: "Choose one", "Choose any", "Optional". */
  .q-eyebrow {
    font-size: 11px; font-weight: 600; letter-spacing: 0.09em; text-transform: uppercase;
    color: var(--task-accent); margin: 0 0 10px;
  }
  /* No font-family: the heading takes each app's own h1 face, so a
     question in Shvil looks like Shvil and not like the selector. */
  .q-block h1 {
    font-size: 30px; line-height: 1.2; letter-spacing: -0.01em;
    margin: 0 0 10px; color: var(--task-ink);
  }
  .q-block .q-desc { margin: 0 0 4px; font-size: 15px; line-height: 1.6; color: var(--task-ink-2); }
  .q-body { margin-top: 24px; }

  /* Choices: full-width rows, generous to hit, with a clear chosen state. */
  .q-options { display: flex; flex-direction: column; gap: 10px; }
  .q-option {
    display: flex; align-items: center; gap: 14px;
    text-align: left; font: inherit; font-size: 16px; color: var(--task-ink);
    background: var(--task-surface-hi);
    border: 1.5px solid var(--task-line);
    border-radius: 14px;
    padding: 15px 18px; min-height: 56px; box-sizing: border-box;
    cursor: pointer;
    transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
  }
  .q-option:hover { border-color: var(--task-accent-hover); box-shadow: 0 2px 10px rgba(0,0,0,0.05); transform: translateY(-1px); }
  .q-option.on { border-color: var(--task-accent); background: var(--task-accent-soft); box-shadow: none; transform: none; }
  .q-option:focus-visible { outline: 2px solid var(--task-accent); outline-offset: 2px; }
  .q-option .mark {
    width: 20px; height: 20px; flex: none; box-sizing: border-box;
    border: 1.5px solid var(--task-mark);
    background: var(--task-surface-hi);
    display: inline-flex; align-items: center; justify-content: center;
    transition: all 0.15s ease;
  }
  .q-option:hover .mark { border-color: var(--task-accent-hover); }
  .q-option .mark.radio { border-radius: 50%; }
  .q-option .mark.box   { border-radius: 6px; }
  .q-option.on .mark.radio { border: 6px solid var(--task-accent); }
  .q-option.on .mark.box { border-color: var(--task-accent); background: var(--task-accent); }
  .q-option.on .mark.box::after {
    content: ''; width: 5px; height: 10px; margin-top: -2px;
    border: solid var(--task-surface-hi); border-width: 0 2px 2px 0; transform: rotate(45deg);
  }
  /* "None of these" is a different kind of answer from the choices, so it
     sits a little apart from them. */
  .q-option[data-optout] { margin-top: 6px; }
  .q-option input.other-text {
    flex: 1; min-width: 0; font: inherit; font-size: 16px;
    border: none; border-bottom: 1px solid var(--task-line);
    background: transparent; padding: 2px 0; color: var(--task-ink);
  }
  .q-option input.other-text::placeholder { color: var(--task-muted); }
  .q-option input.other-text:focus { outline: none; border-bottom-color: var(--task-accent); }

  /* Opinion scale: one bar across the column, ends labelled underneath. */
  .q-scale-wrap { width: 100%; }
  .q-scale { display: flex; gap: 8px; }
  .q-scale button {
    flex: 1 1 0; min-width: 0; height: 56px;
    font: inherit; font-size: 17px; font-weight: 500; color: var(--task-ink);
    border: 1.5px solid var(--task-line); background: var(--task-surface-hi);
    border-radius: 12px; cursor: pointer;
    transition: all 0.15s ease;
  }
  .q-scale button:hover { border-color: var(--task-accent-hover); transform: translateY(-1px); }
  .q-scale button.on { border-color: var(--task-accent); background: var(--task-accent); color: var(--task-surface-hi); transform: none; }
  .q-scale button:focus-visible { outline: 2px solid var(--task-accent); outline-offset: 2px; }
  .q-scale.faces button { font-size: 28px; height: 64px; }
  .q-scale.faces button.on { background: var(--task-accent-soft); border-color: var(--task-accent); }
  .q-scale.stars { gap: 4px; }
  /* Stars sit together, as a rating does, rather than spread to fill. */
  .q-scale.stars button {
    flex: 0 0 52px; font-size: 34px; height: 60px; border-color: transparent; background: none;
    color: var(--task-line-soft);
  }
  .q-scale.stars button:hover { color: var(--task-accent-hover); transform: scale(1.08); }
  .q-scale.stars button.on { color: var(--task-accent); background: none; border-color: transparent; }
  /* Ten points in a phone are ten slivers; two rows of five are buttons. */
  @container (max-width: 440px) {
    .q-scale.many { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
    .q-scale.many button { height: 52px; }
  }
  .q-scale-labels {
    display: flex; justify-content: space-between; gap: 12px;
    margin-top: 10px; font-size: 13px; color: var(--task-muted);
  }
  .q-scale-labels span:nth-child(2) { text-align: center; }
  .q-scale-labels span:last-child { text-align: right; }

  /* Yes/No: two large targets rather than a list that happens to have two
     entries — a binary answer should look binary. */
  .q-binary { display: flex; gap: 14px; flex-wrap: wrap; }
  .q-binary button {
    flex: 1 1 160px; min-height: 132px;
    font: inherit; color: var(--task-ink);
    background: var(--task-surface-hi);
    border: 1.5px solid var(--task-line); border-radius: 16px;
    padding: 22px 18px; cursor: pointer;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px;
    transition: all 0.15s ease;
  }
  .q-binary button:hover { border-color: var(--task-accent-hover); transform: translateY(-1px); box-shadow: 0 2px 10px rgba(0,0,0,0.05); }
  .q-binary button.on { border-color: var(--task-accent); background: var(--task-accent-soft); transform: none; box-shadow: none; }
  .q-binary button:focus-visible { outline: 2px solid var(--task-accent); outline-offset: 2px; }
  .q-binary .glyph {
    width: 48px; height: 48px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; line-height: 1; color: var(--task-ink-2);
    background: var(--task-surface); border: 1.5px solid var(--task-line);
    transition: all 0.15s ease;
  }
  .q-binary button.on .glyph { background: var(--task-accent); border-color: var(--task-accent); color: var(--task-surface-hi); }
  .q-binary .glyph.face { font-size: 30px; background: none; border: none; }
  .q-binary button.on .glyph.face { background: none; }
  .q-binary .word { font-size: 17px; font-weight: 600; }

  /* Matrix: a bordered grid on anything with room; a stack of small groups
     when there is not — decided by the space the question actually has. */
  .q-matrix-card { border: 1.5px solid var(--task-line); border-radius: 14px; overflow: hidden; background: var(--task-surface-hi); }
  .q-matrix { width: 100%; border-collapse: collapse; }
  .q-matrix th, .q-matrix td { padding: 13px 10px; text-align: center; }
  .q-matrix thead th {
    font-size: 12px; font-weight: 600; color: var(--task-ink-3);
    background: var(--task-surface); border-bottom: 1px solid var(--task-line);
  }
  .q-matrix th.stmt, .q-matrix td.stmt { text-align: left; font-size: 15px; color: var(--task-ink); width: 42%; padding-left: 18px; }
  .q-matrix tbody tr + tr td { border-top: 1px solid var(--task-line); }
  .q-matrix tbody tr:hover td { background: var(--task-surface); }
  .q-cell {
    width: 22px; height: 22px; box-sizing: border-box;
    border: 1.5px solid var(--task-mark); background: var(--task-surface-hi);
    cursor: pointer; display: inline-block; vertical-align: middle; transition: all 0.15s ease;
  }
  .q-cell:hover { border-color: var(--task-accent-hover); }
  .q-cell.radio { border-radius: 50%; }
  .q-cell.box { border-radius: 6px; }
  .q-cell.radio.on { border: 7px solid var(--task-accent); }
  .q-cell.box.on { border-color: var(--task-accent); background: var(--task-accent); }
  .q-matrix-stack .stack-group { margin-bottom: 20px; }
  .q-matrix-stack .stack-stmt { font-size: 15px; font-weight: 600; color: var(--task-ink); margin-bottom: 8px; }
  /* Stacked, each statement's choices sit side by side as compact
     buttons — three full-width rows per statement made a short matrix
     several screens long. They wrap when there are many. */
  .q-matrix-stack .stack-group .q-options { flex-direction: row; flex-wrap: wrap; gap: 8px; }
  .q-matrix-stack .stack-group .q-option {
    flex: 1 1 0; min-width: 88px; min-height: 46px; padding: 10px 12px;
    justify-content: center; gap: 8px; font-size: 14px;
  }
  .q-matrix-stack .stack-group .q-option .mark { width: 16px; height: 16px; }
  .q-matrix-stack .stack-group .q-option.on .mark.radio { border-width: 5px; }

  .q-input {
    width: 100%; box-sizing: border-box; font: inherit; font-size: 17px;
    padding: 16px 18px; border: 1.5px solid var(--task-line); border-radius: 14px;
    background: var(--task-surface-hi); color: var(--task-ink);
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .q-input::placeholder { color: var(--task-muted); }
  .q-input:focus { outline: none; border-color: var(--task-accent); box-shadow: 0 0 0 4px var(--task-accent-soft); }
  .q-input-note { font-size: 12px; color: var(--task-muted); margin-top: 8px; }

  .q-actions { margin-top: 32px; display: flex; align-items: center; gap: 18px; }
  .q-continue {
    font: inherit; font-size: 15px; font-weight: 600;
    background: var(--task-accent); color: var(--task-surface-hi);
    border: none; border-radius: 12px; padding: 14px 30px; cursor: pointer;
    transition: background 0.15s ease, opacity 0.15s ease;
  }
  .q-continue:hover:not(:disabled) { filter: brightness(0.9); }
  .q-continue:focus-visible { outline: 2px solid var(--task-accent); outline-offset: 3px; }
  /* Disabled reads as "not yet", not as a faded copy of the button. */
  .q-continue:disabled { background: var(--task-line); color: var(--task-muted); cursor: default; }
  .q-skip {
    font: inherit; font-size: 14px; color: var(--task-muted);
    background: none; border: none; cursor: pointer; text-decoration: underline; padding: 0;
  }
  .q-skip:hover { color: var(--task-ink); }
`;

  // The "All done" screen, styled here rather than borrowed from whichever
  // app happened to come first. It used the shapes app's `.success` and
  // `.restart-btn` classes, which no other app defines, so photo and Shvil
  // finished on unstyled browser defaults. Colours come from the same
  // --task-* variables as the questions; the heading is an <h1>, so it
  // takes each app's own heading font.
  const DONE_CSS = `
  .sd-done {
    /* Fills the host when the host has a height (Shvil's frame, photo's
       phone) so the message sits in the middle; 420px otherwise. */
    min-height: max(420px, 100%); box-sizing: border-box; padding: 56px 24px;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; animation: sdIn 0.45s ease both;
  }
  .sd-badge {
    width: 76px; height: 76px; border-radius: 50%; margin-bottom: 26px;
    background: var(--task-accent); color: var(--task-surface);
    display: flex; align-items: center; justify-content: center;
    animation: sdPop 0.5s cubic-bezier(0.2, 0.8, 0.3, 1) both;
  }
  .sd-done h1 { font-size: 40px; line-height: 1.1; margin: 0 0 12px; color: var(--task-ink); }
  .sd-copy { font-size: 17px; line-height: 1.5; color: var(--task-ink-2); margin: 0 0 30px; max-width: 420px; }
  .sd-btn {
    font: inherit; font-size: 15px; font-weight: 600; cursor: pointer;
    background: var(--task-accent); color: var(--task-surface);
    border: none; border-radius: 12px; padding: 13px 30px;
    transition: background 0.15s ease;
  }
  .sd-btn:hover:not(:disabled) { background: var(--task-accent-hover); }
  .sd-btn:disabled { opacity: 0.6; cursor: default; }
  @keyframes sdIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }
  @keyframes sdPop { from { transform: scale(0.6); opacity: 0; } to { transform: none; opacity: 1; } }
  `;

  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected || !document.head) return;
    stylesInjected = true;
    const el = document.createElement('style');
    el.id = 'study-task-css';
    el.textContent = TASK_CSS + DONE_CSS;
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
  const currentTaskId = () => { const t = currentTask(); return t ? t.task_id : null; };
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
  // app behaved before modes existed, and to no free-play gaze.
  //
  // select('*') rather than a column list, here and in loadBattery(): a
  // list written before a column existed silently drops that column, and
  // that is exactly how entry_step was saved, shown in the dashboard, and
  // never once reached a participant. It also means a column that does
  // not exist yet (a migration not run) is simply absent instead of
  // failing the whole read and dropping every participant to free play.
  async function loadSettings() {
    const fallback = { mode: 'tasks', gaze_free: false };
    if (TRACKING_OFF || !window.supabaseClient) return fallback;
    try {
      const { data, error } = await supabaseClient
        .from('study_settings').select('*').eq('app', cfg.app).maybeSingle();
      if (error || !data) return fallback;
      return { mode: data.mode || 'tasks', gaze_free: data.gaze_free === true };
    } catch { return fallback; }
  }

  async function loadBattery() {
    if (TRACKING_OFF || !window.supabaseClient) return [];
    try {
      const { data, error } = await supabaseClient
        .from('tasks')
        .select('*')
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
      // Every route task starts on its own pre-screen: what to do and how
      // it works, then a Start button. The app is reset, and the clock
      // started, only once they press it.
      showPreScreen(t, () => startRoute(t));
      return;
    }

    cfg.chrome('question');
    renderQuestion(t);
  }

  // The moment a route task actually begins. Its clock starts here, after
  // the participant has read the goal and chosen to start, so the time
  // spent reading the card is not counted as time spent on the task.
  function startRoute(t) {
    taskStartedAt = Date.now();
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
    // authoring UI), so scoring is unaffected either way. The state the
    // author had built up by that step comes with it, so the screen is
    // the one they demonstrated rather than one filled with defaults.
    cfg.resetApp(t.entry_step || null, t.entry_state || null);
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

    // Reaching the goal used to swap the app for the next thing without a
    // word, and participants could not tell they had succeeded. Now the
    // result gets a screen of its own, about that task only, and they click
    // on from it. After the last task "All done" says it instead — two
    // closing screens in a row would be one too many.
    if (!battery[taskIndex + 1]) { nextTask(); return; }
    showResultScreen(how, nextTask);
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
    // A description that only repeats the question adds a second copy of
    // the same line, which reads as a mistake rather than as help.
    const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
    const desc = c.description && !same(c.description, t.goal_text)
      ? `<p class="q-desc">${escapeHtml(c.description)}</p>` : '';
    const body = QUESTION_BODY[t.kind] ? QUESTION_BODY[t.kind](c) : choiceMarkup(c);

    host.innerHTML = `
      <div class="q-block">
        <p class="q-eyebrow">${escapeHtml(answerHint(t.kind, c))}</p>
        <h1>${escapeHtml(t.goal_text)}</h1>
        ${desc}
        <div class="q-body">${body}</div>
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

  // What kind of answer is wanted, said up front. A participant should not
  // have to click to find out whether several choices are allowed.
  function answerHint(kind, c) {
    const lo = c.start_at_one === false ? 0 : 1;
    const hint = {
      multiple_choice: c.select === 'multi' ? 'Choose any that apply' : 'Choose one',
      opinion_scale: c.display === 'stars' ? 'Rate it' : `Rate from ${lo} to ${lo + (c.steps || 10) - 1}`,
      yes_no: 'Yes or no',
      matrix: c.select === 'multi' ? 'Any that apply, for each row' : 'One answer for each row',
      simple_input: ({ number: 'A number', date: 'A date', email: 'Your email' })[c.input_type] || 'In your own words'
    }[kind] || 'Question';
    return c.required === false ? `${hint} · Optional` : hint;
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
    return `<div class="q-scale-wrap"><div class="q-scale ${display}${steps > 6 ? ' many' : ''}">${buttons}</div>${labels}</div>`;
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
      `<button type="button" data-v="${v}"><span class="glyph${emo ? ' face' : ''}">${glyph}</span><span class="word">${word}</span></button>`;
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
    // Measured on the space the question actually has, not the window:
    // photo's phone is 375px wide inside a full-size browser, and a grid
    // squeezed into it is unreadable whatever the window says.
    const host = slot('question');
    const room = host ? host.clientWidth : window.innerWidth;
    const stack = room < 560 || (c.optimize_small && window.innerWidth < 620);

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

    return `<div class="q-matrix-card"><table class="q-matrix">
      <thead><tr><th class="stmt"></th>
        ${choices.map(ch => `<th>${escapeHtml(ch)}</th>`).join('')}</tr></thead>
      <tbody>
        ${statements.map(st => `<tr data-stmt="${escapeHtml(st)}">
          <td class="stmt">${escapeHtml(st)}</td>
          ${choices.map(ch => `<td>
            <span class="q-cell ${mark}" data-stmt="${escapeHtml(st)}" data-v="${escapeHtml(ch)}"></span>
          </td>`).join('')}
        </tr>`).join('')}
      </tbody></table></div>${optOut}`;
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
    markCompleted(batteryKey);
    cfg.chrome('done');
    const host = slot('question');
    if (!host) return;
    host.innerHTML = `
      <div class="sd-done">
        <div class="sd-badge">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
        </div>
        <h1>All done</h1>
        <p class="sd-copy">Thank you — that is everything we needed.</p>
        <button class="sd-btn" id="done-btn">I'm done</button>
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
      // The camera is only worth mentioning to someone who turned it on.
      // Telling a participant who declined that their camera is off is at
      // best confusing, and at worst suggests it had been on all along.
      const wasTracking = gazeOn;
      await stopTracking('participant finished the study');
      let label = 'Thanks';
      try { label = (await cfg.onFinish()) || label; }
      catch (err) { console.warn('onFinish failed', err); }
      b.textContent = wasTracking ? 'Thanks — camera off' : label;
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

    // The snapshot is taken before the app applies this choice, so it is
    // the state the author had when they reached this screen — which is
    // what a task starting here needs restored, not the state after it.
    reportToAuthor('choice', { step, value, state: AUTHOR_MODE ? safeSnapshot() : null });
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

  // Read the settings and the battery, settle eye tracking, then open the
  // session — in that order. The mode and the gaze decision both have to
  // be known before the session row is written, so it can record them as
  // an insert (visitors may append rows and nothing more). And whether to
  // ask for the camera at all depends on the battery: it is asked for
  // only if something this participant will do has eye tracking switched
  // on. Loading the battery is a read; its answers wait on the session
  // through write(), so reading it first races nothing.
  async function startStudy({ beforeSession } = {}) {
    const settings = await loadSettings();
    studyMode = settings.mode;
    battery = studyMode === 'free' ? [] : await loadBattery();

    // Once per battery, per browser. Someone who has finished this exact
    // set of tasks and opens the link again would bring what they learned
    // the first time into the second — faster, more direct, and averaged
    // in as if it were a first attempt. In "Tasks only" they get a closing
    // screen and nothing is recorded; in "Free style, then tasks" they may
    // still explore, but are not offered the tasks again.
    batteryKey = batteryKeyOf(battery);
    if (batteryKey && !RETAKE && completedBefore(batteryKey)) {
      if (studyMode === 'tasks') {
        showAlreadyTookPart();
        return { started: false, offer: false, alreadyTookPart: true };
      }
      battery = [];
    }

    // One switch per app, all or nothing: free exploration and every
    // in-app task. Asked for only when this participant will meet at least
    // one of those — a battery of questions alone has nothing to look at.
    gazeFree = settings.gaze_free;
    const appTime = studyMode !== 'tasks' || battery.length === 0
      || battery.some(t => t.kind === 'app_route');
    gazeState = (gazeFree && appTime) ? await setUpGaze() : null;

    if (beforeSession) await beforeSession();
    begin(false);
    if (gazeOn) startGazeUpkeep();

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

  // Only a route task can be given up. A stale "move on" link left on
  // screen during a question must not record one against the question.
  function giveUp() {
    const t = currentTask();
    if (t && t.kind === 'app_route') finishRouteTask('gave_up');
  }

  // ------------------------------------------------------------------
  // Between tasks
  //
  // Two screens, each about one thing, the same in every app and drawn
  // over the app so no app's layout has to make room for them:
  //   result     — after a route task: celebrates it, or acknowledges a
  //                skip. About that task only.
  //   pre-screen — before a route task: what to do and how it works.
  //                About the next task only.
  // Between two route tasks a participant sees both, in that order. Both
  // wait for a click: advancing on its own is what made the switch
  // between tasks impossible to notice. A first version put the result on
  // the next screen as a strip, and one screen talking about two tasks
  // read as one confusing message.
  // ------------------------------------------------------------------
  let transitionUp = false;

  const TRANSITION_CSS = `
  .st-overlay {
    position: fixed; inset: 0; z-index: 2147481000;
    display: flex; align-items: center; justify-content: center; padding: 24px;
    background: color-mix(in srgb, var(--task-ink) 38%, transparent);
    backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px);
    animation: stFade 0.2s ease both;
  }
  .st-overlay.leaving { animation: stFadeOut 0.18s ease both; }
  /* The pre-screen is a screen, not a pop-up: the app is not visible
     behind it until the task actually starts. */
  .st-overlay.screen { background: var(--task-surface); backdrop-filter: none; -webkit-backdrop-filter: none; }
  .st-overlay.screen .st-card { max-width: 520px; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.08); border: 1px solid var(--task-line); }
  .st-badge {
    position: relative; width: 84px; height: 84px; margin: 4px auto 22px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    background: var(--task-accent); color: var(--task-surface-hi);
    animation: stPop 0.55s 0.1s cubic-bezier(0.2, 0.8, 0.3, 1.4) both;
  }
  .st-badge.soft { background: var(--task-accent-soft); color: var(--task-accent); }
  .st-badge svg path { stroke-dasharray: 30; stroke-dashoffset: 30; animation: stDraw 0.4s 0.4s ease forwards; }
  .st-badge .st-confetti { top: 50%; }
  .st-sub { margin: 0; font-size: 16px; line-height: 1.55; color: var(--task-ink-2); }
  .st-count { margin: 10px 0 0; font-size: 12px; color: var(--task-muted); }
  .st-dots span.now { animation: stFill 0.6s 0.35s ease both; }
  .st-how {
    margin: 20px 0 0; padding: 0; list-style: none; text-align: left;
    border-top: 1px solid var(--task-line);
  }
  .st-how li {
    display: flex; gap: 12px; align-items: flex-start;
    padding: 12px 2px; border-bottom: 1px solid var(--task-line);
    font-size: 14px; line-height: 1.5; color: var(--task-ink-2);
  }
  .st-how li b { color: var(--task-ink); font-weight: 600; }
  .st-how .ic { flex: none; width: 20px; text-align: center; color: var(--task-accent); font-size: 15px; line-height: 1.4; }
  .st-card {
    position: relative; box-sizing: border-box;
    width: 100%; max-width: 440px; padding: 36px 32px 30px;
    background: var(--task-surface-hi); color: var(--task-ink);
    border-radius: 22px; text-align: center;
    box-shadow: 0 24px 70px rgba(0, 0, 0, 0.22);
    animation: stRise 0.35s cubic-bezier(0.2, 0.8, 0.3, 1) both;
  }
  .st-eyebrow {
    margin: 0 0 8px; font-size: 11px; font-weight: 600; letter-spacing: 0.09em;
    text-transform: uppercase; color: var(--task-accent);
  }
  /* No font-family: the title takes each app's own h1 face. */
  .st-card h1 { font-size: 28px; line-height: 1.2; margin: 0 0 8px; color: var(--task-ink); }
  .st-dots { display: flex; justify-content: center; gap: 6px; margin: 18px 0 0; }
  .st-dots span { width: 22px; height: 5px; border-radius: 3px; background: var(--task-line); }
  .st-dots span.done { background: var(--task-accent); }
  .st-go {
    margin-top: 24px; width: 100%;
    font: inherit; font-size: 16px; font-weight: 600;
    background: var(--task-accent); color: var(--task-surface-hi);
    border: none; border-radius: 14px; padding: 15px 22px; cursor: pointer;
    transition: filter 0.15s ease, transform 0.15s ease;
  }
  .st-go:hover { filter: brightness(0.92); }
  .st-go:active { transform: scale(0.98); }
  .st-go:focus-visible { outline: 2px solid var(--task-accent); outline-offset: 3px; }
  /* A small burst from the badge on success only. */
  .st-confetti { position: absolute; left: 50%; width: 0; height: 0; pointer-events: none; }
  .st-confetti i {
    position: absolute; width: 7px; height: 11px; border-radius: 2px; opacity: 0;
    animation: stBurst 0.9s 0.15s cubic-bezier(0.1, 0.7, 0.3, 1) forwards;
  }
  @keyframes stFade { from { opacity: 0; } to { opacity: 1; } }
  @keyframes stFadeOut { to { opacity: 0; } }
  @keyframes stRise { from { opacity: 0; transform: translateY(16px) scale(0.97); } to { opacity: 1; transform: none; } }
  @keyframes stPop { from { transform: scale(0.4); opacity: 0; } to { transform: none; opacity: 1; } }
  @keyframes stDraw { to { stroke-dashoffset: 0; } }
  @keyframes stFill { from { background: var(--task-line); } to { background: var(--task-accent); } }
  @keyframes stBurst {
    0% { opacity: 1; transform: translate(0, 0) rotate(0); }
    100% { opacity: 0; transform: translate(var(--x), var(--y)) rotate(var(--r)); }
  }
  @media (prefers-reduced-motion: reduce) {
    .st-overlay, .st-card, .st-badge, .st-badge svg path, .st-dots span.now { animation: none; }
    .st-badge svg path { stroke-dashoffset: 0; }
    .st-confetti { display: none; }
  }`;

  let transitionCssIn = false;

  function confetti() {
    const colours = ['var(--task-accent)', 'var(--task-accent-hover)', 'var(--task-accent-line)', 'var(--task-ink-3)'];
    let out = '';
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      const d = 90 + (i % 3) * 30;
      out += `<i style="--x:${Math.round(Math.cos(a) * d)}px;--y:${Math.round(Math.sin(a) * d - 20)}px;`
        + `--r:${(i * 47) % 360}deg;background:${colours[i % colours.length]}"></i>`;
    }
    return `<div class="st-confetti" aria-hidden="true">${out}</div>`;
  }

  function ensureTransitionCss() {
    if (transitionCssIn) return;
    transitionCssIn = true;
    const st = document.createElement('style');
    st.id = 'study-transition-css';
    st.textContent = TRANSITION_CSS;
    document.head.insertBefore(st, document.head.firstChild);
  }

  const CHECK_SVG = '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
  const ARROW_SVG = '<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

  // The task just finished: celebrated, or a skip acknowledged without
  // fuss. Nothing here about what comes next.
  function showResultScreen(how, onGo) {
    const done = taskIndex + 1;
    const dots = battery.map((_, i) =>
      `<span class="${i < done ? 'done' : ''}${i === done - 1 && how === 'reached' ? ' now' : ''}"></span>`).join('');
    const body = how === 'reached'
      ? `<div class="st-badge">${confetti()}${CHECK_SVG}</div>
         <h1>Task complete!</h1>
         <p class="st-sub">Nice work — you did it.</p>`
      : `<div class="st-badge soft">${ARROW_SVG}</div>
         <h1>No problem</h1>
         <p class="st-sub">That one was tricky. We've moved on.</p>`;
    mountScreen(`${body}
      <div class="st-dots">${dots}</div>
      <p class="st-count">${done} of ${battery.length} done</p>
      <button class="st-go" type="button">Continue →</button>`, onGo);
  }

  // The task about to start: what to do, and how these tasks behave — the
  // app never says "correct", so they need to know that moving on is the
  // sign, and that there is a way out if they are stuck.
  function showPreScreen(task, onGo) {
    const dots = battery.map((_, i) => `<span class="${i < taskIndex ? 'done' : ''}"></span>`).join('');
    mountScreen(`
      <p class="st-eyebrow">Task ${taskIndex + 1} of ${battery.length}</p>
      <h1>${escapeHtml(task.goal_text)}</h1>
      <ul class="st-how">
        <li><span class="ic">◎</span><span><b>Use the app</b> to do this, the way you normally would.</span></li>
        <li><span class="ic">→</span><span><b>You'll move on automatically</b> as soon as it's done. There's no need to tell us.</span></li>
        <li><span class="ic">⤼</span><span><b>Stuck?</b> You can skip it at any time — the task stays on screen with a "move on" link.</span></li>
      </ul>
      <div class="st-dots">${dots}</div>
      <button class="st-go" type="button">Start task →</button>`, onGo);
  }

  function mountScreen(inner, onGo) {
    ensureTransitionCss();
    const el = document.createElement('div');
    el.className = 'st-overlay screen';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.innerHTML = `<div class="st-card">${inner}</div>`;
    document.body.appendChild(el);
    transitionUp = true;
    const go = el.querySelector('.st-go');
    // Focused, so Enter or Space moves on too.
    setTimeout(() => { try { go.focus({ preventScroll: true }); } catch {} }, 60);
    go.addEventListener('click', () => {
      transitionUp = false;
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 180);
      onGo();
    }, { once: true });
  }

  // ------------------------------------------------------------------
  // Once per battery
  //
  // A battery is the exact set of active tasks. Adding, removing,
  // activating or deactivating one makes a new battery that earlier
  // participants may take; reordering the same tasks does not. Kept in
  // this browser's storage — a private window or another device is a new
  // participant as far as this can tell, which is why it is a courtesy,
  // not a guarantee.
  // ------------------------------------------------------------------
  let batteryKey = null;
  const batteryKeyOf = (list) => list.length
    ? `idc_hci_done:${cfg.app}:${list.map(t => t.task_id).sort().join(',')}` : null;
  function completedBefore(key) {
    try { return !!localStorage.getItem(key); } catch { return false; }
  }
  function markCompleted(key) {
    if (!key || TRACKING_OFF) return;
    try { localStorage.setItem(key, new Date().toISOString()); } catch {}
  }
  function showAlreadyTookPart() {
    ensureTransitionCss();
    const el = document.createElement('div');
    el.className = 'st-overlay screen';
    el.setAttribute('role', 'dialog');
    el.innerHTML = `<div class="st-card">
      <div class="st-badge soft">${CHECK_SVG}</div>
      <h1>You've already taken part</h1>
      <p class="st-sub">Thank you — you've completed this study, so there's nothing more to do. You can close this page.</p>
    </div>`;
    document.body.appendChild(el);
    // Nothing behind it may be clicked or recorded: no session was opened.
    transitionUp = true;
  }

  // The state a preview should be drawn with, or null for the defaults.
  function previewState() {
    if (!PREVIEW_MODE) return null;
    if (PREVIEW_STATE && typeof PREVIEW_STATE === 'object') return PREVIEW_STATE;
    if (Array.isArray(PREVIEW_ROUTE) && PREVIEW_ROUTE.length) {
      try { return cfg.stateFromRoute(PREVIEW_ROUTE) || null; }
      catch (err) { console.warn('stateFromRoute failed; previewing with defaults', err); }
    }
    return null;
  }

  // Never lets an app's snapshot break authoring: a hook that throws, or
  // returns something JSON cannot hold, means "no state", not "no route".
  function safeSnapshot() {
    try {
      const s = cfg.snapshot && cfg.snapshot();
      return s == null ? null : JSON.parse(JSON.stringify(s));
    } catch (err) {
      console.warn('snapshot failed; this step will start with default state', err);
      return null;
    }
  }


  // ==================================================================
  // Webcam gaze tracking
  //
  // WebGazer estimates a gaze point from the webcam entirely in the
  // browser. Frames are never uploaded and there is no column that could
  // hold one — only the estimated point is written, in exactly the same
  // box-relative coordinates as clicks so the two overlay cleanly.
  //
  // Off unless the dashboard switches it on for the app, and then it is
  // all or nothing: free exploration and every in-app task. A switch per
  // task was tried first and dropped — it meant a camera that was on but
  // not recording for parts of a run. Asked for once, up front, because
  // calibrating halfway through a battery would put a minute of
  // dot-clicking inside a task's timing. Question screens never record.
  //
  // Accuracy is region-level, not button-level, and that was measured
  // rather than assumed: it answers "did they scan the whole row before
  // choosing", not "were they looking at B or at C". The dashboard says
  // so next to every gaze heatmap.
  // ==================================================================

  const GAZE_LIB = 'https://cdn.jsdelivr.net/npm/webgazer@3.5.3/dist/webgazer.min.js';

  // WebGazer detects faces with MediaPipe, whose assets it does NOT bundle.
  // Its default for these is the relative path './mediapipe/face_mesh',
  // i.e. it expects you to self-host them. Left alone it resolves against
  // the page's own directory, 404s, and then calls the loader global that
  // was never defined — surfacing as "TypeError: t is not a function"
  // AFTER the camera has already opened, which makes it look like a camera
  // problem when it is a missing-asset problem.
  const FACE_MESH_PATH = 'https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh';
  // 20 Hz. At 10 Hz a fixation was only two or three samples long, which
  // is too few to tell a steady look apart from two noisy ones.
  const GAZE_SAMPLE_MS = 50;
  const GAZE_FLUSH_MS = 5000;
  const GAZE_MAX_BUFFER = 400;   // offline safety valve, in fixations

  // Samples are clustered into fixations in the browser and only the
  // settled ones are uploaded. Storing every sample was ~450 rows per
  // participant for a picture that blurs at this radius regardless.
  //
  // In pixels, because that is what the tracker's noise is measured in.
  // It used to be 0.15 of the shapes app's 560px column (~84px); as a
  // fraction it would mean 56px on photo's 375px phone and 177px across
  // Shvil's 1180px frame — the same constant meaning three different
  // things. Webcam gaze jitters by more than ~80px between consecutive
  // samples even while you hold still, so a tighter radius starts a new
  // fixation on almost every sample and the whole run collapses.
  const FIXATION_RADIUS_PX = 84;
  // Two samples. The floor exists only to drop single-sample blips mid-
  // saccade; it is deliberately not a real fixation threshold. Set higher
  // (150ms) it discarded roughly 70% of tracked time, most of it on short
  // decision screens.
  const FIXATION_MIN_MS = 100;

  // Five clicks a dot, nine dots: 45 training samples. Fifteen produced a
  // prediction that wandered regardless of where the participant looked.
  const CALIB_CLICKS = 5;
  // Which entry in CALIB_POINTS sits at screen centre, under the hint text.
  const CENTRE_POINT = 4;
  // Edge coverage matters for stabilising the fit, not only for edge
  // accuracy — five points with three clicks each could not fit at all.
  const CALIB_POINTS = [
    [12, 14], [50, 14], [88, 14],
    [12, 50], [50, 50], [88, 50],
    [12, 86], [50, 86], [88, 86]
  ];
  // Short moving average over the raw predictions. Clustering a jittery
  // signal directly means the jitter, not the eye, decides where one
  // fixation ends and the next begins.
  const SMOOTH_WINDOW = 3;

  // null when eye tracking was never on the table for this participant
  // (nothing asked for it); otherwise one of the values the sessions
  // table's CHECK allows.
  let gazeState = null;
  let gazeOn = false;
  let gazeFree = false;        // the app's eye-tracking switch
  let gazeOverlayUp = false;   // consent or calibration owns the screen
  let gazeBuffer = [];         // closed fixations waiting to be sent
  let fixation = null;         // the look currently being accumulated
  let gazeLastSample = 0;
  let gazeRecent = [];
  let gazeDropped = 0;         // fixations too brief to keep; watched in debug
  let gazeSent = 0, gazeSamples = 0;
  // What a fixation belongs to: screen, overlay and task. When any of
  // them changes, the look in progress ends — the same position on the
  // next screen means something else — and the screen clock restarts.
  let gazeCtx = null, gazeCtxSince = Date.now();

  // Does what is on screen right now want its gaze recorded?
  function gazeWanted() {
    if (!gazeFree) return false;
    const t = currentTask();
    if (t) return t.kind === 'app_route';
    // Before the battery (or with none): free exploration. After it the
    // participant is on "All done", which belongs to nothing.
    return taskIndex === -1;
  }

  // Asking for the camera at all only makes sense on a device that has a
  // usable one and a context allowed to open it. Phones are excluded on
  // purpose: the camera points at the face from an angle that changes
  // every second the phone is held, so the estimate is noise.
  function gazeSupported() {
    return !TRACKING_OFF
      && platform === 'desktop'
      && window.isSecureContext
      && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // Size of the regression's training set. Zero means the calibration
  // clicks never reached it, which is a different problem entirely from a
  // model that was trained and still fits badly.
  function trainingSamples() {
    try {
      const reg = webgazer.getRegression()[0];
      if (reg.screenXClicksArray && reg.screenXClicksArray.data) return reg.screenXClicksArray.data.length;
      const d = reg.getData();
      return Array.isArray(d) ? d.length : '?';
    } catch { return '?'; }
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`could not load ${src}`));
      document.head.appendChild(el);
    });
  }

  // Captures the session and its readiness promise synchronously, before
  // any await — so a flush triggered by Start over sends the fixations it
  // drained to the session they were actually recorded in, not the new one.
  // Sends closed fixations only: closing on the flush timer would chop a
  // long look into five-second pieces and report it as several glances.
  function flushGaze() {
    if (!window.supabaseClient || !gazeBuffer.length) return Promise.resolve();
    const rows = gazeBuffer;
    gazeBuffer = [];
    gazeSent += rows.length;
    const sid = sessionId, ready = sessionReady;
    return (async () => {
      try {
        await ready;
        const { error } = await supabaseClient.from('gaze')
          .insert(rows.map(r => ({ session_id: sid, ...r })));
        if (error) console.error('insert into gaze failed', error);
      } catch (err) {
        console.error('insert into gaze failed', err);
      }
    })();
  }

  // Ends the fixation in progress and queues it, unless it was too brief
  // to be a look. Safe to call at any time, including with none open.
  function closeFixation() {
    const f = fixation;
    fixation = null;
    if (!f) return;
    // Span the samples it holds plus the interval each one stands for, so
    // a single-sample fixation counts as the time it represents, not zero.
    const dur_ms = (f.lastAt - f.startAt) + GAZE_SAMPLE_MS;
    if (dur_ms < FIXATION_MIN_MS) { gazeDropped += 1; return; }
    if (gazeBuffer.length >= GAZE_MAX_BUFFER) return;
    gazeBuffer.push({ step: f.step, overlay: f.overlay, x: f.x, y: f.y,
                      t_ms: f.t_ms, dur_ms, task_id: f.task_id });
  }

  function onGazeSample(data) {
    if (!gazeOn || !data) return;
    gazeSamples += 1;
    const now = Date.now();
    if (now - gazeLastSample < GAZE_SAMPLE_MS) return;
    gazeLastSample = now;

    // Track the context on every sample, recorded or not, so the screen
    // clock is right when recording resumes on a later screen.
    const step = cfg.currentStep();
    const overlay = cfg.currentOverlay();
    const taskId = currentTaskId();
    const ctx = `${step}|${overlay}|${taskId}`;
    if (ctx !== gazeCtx) {
      closeFixation();
      gazeRecent = [];
      gazeCtx = ctx;
      gazeCtxSince = now;
    }

    // A question is not the app, and a context that did not ask for gaze
    // is not recorded — the camera stays on between gaze tasks rather
    // than asking twice, but nothing outside them is written.
    if (!step || !onAppScreen() || gazeOverlayUp || transitionUp || !gazeWanted()) {
      closeFixation();
      return;
    }

    // Same anchor as clicks: the app's measured box, not the viewport.
    // Gaze and clicks are only comparable if they mean the same thing,
    // and the dashboard draws both onto one preview.
    const box = cfg.content();
    if (!box) return;
    const rect = box.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (data.x - rect.left) / rect.width;
    const y = (data.y - rect.top) / rect.height;
    // A prediction comes back NaN while the face is out of frame. Storing
    // that would poison every average computed over the box.
    if (!isFinite(x) || !isFinite(y)) return;

    // Kept for the debug readout: the mapped value alone cannot show
    // whether the raw prediction was already in the wrong place.
    if (DEBUG) window.__lastGaze = { x: data.x, y: data.y, cx: x, cy: y };

    gazeRecent.push({ x, y });
    if (gazeRecent.length > SMOOTH_WINDOW) gazeRecent.shift();
    const sx = gazeRecent.reduce((n, p) => n + p.x, 0) / gazeRecent.length;
    const sy = gazeRecent.reduce((n, p) => n + p.y, 0) / gazeRecent.length;

    // Still in the same place: fold this sample into the open fixation.
    // A running mean, so a long look sits at its centre rather than
    // wherever its first stray sample landed.
    if (fixation
        && Math.abs(sx - fixation.x) * rect.width  < FIXATION_RADIUS_PX
        && Math.abs(sy - fixation.y) * rect.height < FIXATION_RADIUS_PX) {
      fixation.x += (sx - fixation.x) / (fixation.n + 1);
      fixation.y += (sy - fixation.y) / (fixation.n + 1);
      fixation.n += 1;
      fixation.lastAt = now;
      return;
    }

    closeFixation();
    fixation = {
      // Pinned now, not at close: a look belongs to the screen, overlay
      // and task it started in.
      step, overlay, task_id: taskId,
      t_ms: Math.max(0, now - gazeCtxSince),
      x: sx, y: sy, n: 1, startAt: now, lastAt: now
    };
  }

  // ---- participant-facing UI ------------------------------------------
  // Injected only when an app actually asks for the camera, so an app
  // whose study never uses gaze carries none of it. Colours are variables
  // defaulting to the shapes app's palette, like the task CSS above; an
  // app can restate them.
  const GAZE_CSS = `
  :root {
    --gaze-bg: #F0EEE6; --gaze-surface: #FAF9F5; --gaze-ink: #29261F;
    --gaze-ink-2: #5C574C; --gaze-muted: #8A8578; --gaze-line: #D8D3C6;
    --gaze-accent: #C15F3C; --gaze-accent-hover: #A94E2E; --gaze-accent-soft: #F6E9E1;
    --gaze-accent-line: #C9A491;
    --gaze-heading: 'Newsreader', Georgia, serif;
  }
  /* [hidden] only sets display:none from the UA stylesheet, so a class
     that sets display at all beats it — which here is the difference
     between a working study and a blank screen. */
  .sg-overlay[hidden], .sg-stop[hidden], .sg-note[hidden] { display: none !important; }
  .sg-overlay {
    position: fixed; inset: 0; z-index: 2147483000;
    background: var(--gaze-bg); display: flex; align-items: center; justify-content: center;
    padding: 32px; font-family: inherit; color: var(--gaze-ink);
  }
  .sg-card { max-width: 460px; }
  .sg-card h1 {
    font-family: var(--gaze-heading); font-size: 30px; font-weight: 500;
    margin: 0 0 12px; letter-spacing: -0.01em; color: var(--gaze-ink);
  }
  .sg-card p { margin: 0 0 14px; font-size: 15px; line-height: 1.6; color: var(--gaze-ink-2); }
  .sg-points { margin: 0 0 22px; padding-left: 18px; font-size: 14px; line-height: 1.7; color: var(--gaze-ink-2); }
  .sg-actions { display: flex; gap: 10px; flex-wrap: wrap; }
  .sg-btn {
    font: inherit; font-size: 15px; border-radius: 10px; padding: 11px 20px;
    cursor: pointer; border: 1px solid transparent; transition: all 0.2s ease;
  }
  .sg-btn.primary { background: var(--gaze-accent); color: var(--gaze-surface); }
  .sg-btn.primary:hover { background: var(--gaze-accent-hover); }
  .sg-btn.ghost { background: transparent; color: var(--gaze-ink-2); border-color: var(--gaze-line); }
  .sg-btn.ghost:hover { color: var(--gaze-ink); }

  /* Calibration is deliberately stark: anything else on screen competes
     for the gaze we are trying to anchor to a known point. */
  .sg-calib { display: block; padding: 0; }
  .sg-calib-hint {
    position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
    text-align: center; max-width: 300px; pointer-events: none;
  }
  .sg-calib-hint strong { display: block; font-size: 17px; margin-bottom: 6px; }
  .sg-calib-hint span { font-size: 14px; color: var(--gaze-ink-2); line-height: 1.6; }
  /* The centre dot sits exactly where the hint is, so the hint fades
     once that dot's turn comes around. */
  .sg-calib-hint.dimmed { opacity: 0.15; }
  .sg-dot {
    position: absolute; width: 36px; height: 36px; margin: -18px 0 0 -18px;
    border-radius: 50%; border: 2px solid var(--gaze-accent);
    background: rgba(193, 95, 60, 0.12); cursor: pointer; padding: 0;
    transition: opacity 0.25s ease, transform 0.15s ease;
  }
  .sg-dot:hover { transform: scale(1.15); }
  .sg-dot.done { opacity: 0.2; pointer-events: none; }
  .sg-dot .fill {
    position: absolute; inset: 2px; border-radius: 50%; background: var(--gaze-accent);
    transform: scale(0); transition: transform 0.2s ease;
  }
  .sg-calib-progress {
    position: absolute; bottom: 64px; left: 50%; transform: translateX(-50%);
    font-size: 13px; color: var(--gaze-ink-2);
  }
  .sg-calib-skip {
    position: absolute; bottom: 24px; left: 50%; transform: translateX(-50%);
    background: var(--gaze-surface); border-color: var(--gaze-accent-line);
    color: var(--gaze-ink); font-size: 14px;
  }
  /* Says what skipping costs, right next to the button that does it. */
  .sg-calib-skip-note {
    position: absolute; bottom: 8px; left: 50%; transform: translateX(-50%);
    font-size: 11px; color: var(--gaze-muted); white-space: nowrap;
  }

  /* Always reachable while tracking is on. Consent that cannot be
     withdrawn mid-run is not really consent. */
  .sg-stop {
    position: fixed; top: 16px; right: 16px; z-index: 2147482000;
    display: inline-flex; align-items: center; gap: 7px;
    font: inherit; font-size: 13px; color: var(--gaze-ink-2);
    background: var(--gaze-surface); border: 1px solid var(--gaze-line);
    border-radius: 999px; padding: 7px 14px; cursor: pointer;
    box-shadow: 0 2px 10px rgba(41,38,31,0.10);
  }
  .sg-stop:hover { border-color: var(--gaze-accent); color: var(--gaze-ink); }
  .sg-stop .rec { width: 8px; height: 8px; border-radius: 50%; background: var(--gaze-accent); }

  /* A failure here is silent by design — the study must run regardless —
     but silent also meant undiagnosable. This says what went wrong
     without blocking anything. */
  .sg-note {
    position: fixed; left: 16px; bottom: 16px; z-index: 2147483001; max-width: 420px;
    background: var(--gaze-accent-soft); border: 1px solid var(--gaze-accent-line);
    border-radius: 10px; padding: 10px 12px; font-size: 12px; line-height: 1.5;
    color: var(--gaze-ink-2);
  }
  .sg-note code {
    display: block; white-space: pre-wrap; margin-top: 4px; font-size: 11px;
    color: #8A3D1E; word-break: break-word;
  }

  /* WebGazer parks its gaze dot, face overlay and feedback box at very
     high z-index. Any of them left transparent would swallow clicks meant
     for a calibration dot, and none of them is ever a click target. */
  #webgazerGazeDot, #webgazerFaceOverlay, #webgazerFaceFeedbackBox { pointer-events: none !important; }
  /* Its preview video: corner-parked so the participant can check their
     framing, above the framing card that tells them to look at it. */
  #webgazerVideoContainer {
    pointer-events: none !important; position: fixed !important;
    top: 16px !important; left: 16px !important; z-index: 2147483002 !important;
    border-radius: 10px; overflow: hidden; opacity: 0.85;
  }`;

  const GAZE_HTML = `
  <div class="sg-overlay" id="sg-consent" hidden>
    <div class="sg-card">
      <h1>Can we use your camera?</h1>
      <p>This study can estimate roughly where you look on the screen while you use the app. It is optional — everything works exactly the same either way.</p>
      <ul class="sg-points">
        <li>The video never leaves your computer. Nothing is recorded or uploaded.</li>
        <li>Only an estimate of where on the page you were looking is saved.</li>
        <li>There is a setup step first: click nine dots, five times each. It takes about a minute.</li>
      </ul>
      <div class="sg-actions">
        <button class="sg-btn primary" id="sg-allow">Use my camera</button>
        <button class="sg-btn ghost" id="sg-decline">Continue without it</button>
      </div>
    </div>
  </div>
  <!-- Framing is confirmed here, while the preview is up and nothing else
       is on screen. It cannot stay visible into calibration: the preview
       sits over the top-left corner, directly on top of the dot there. -->
  <div class="sg-overlay" id="sg-frame" hidden>
    <div class="sg-card">
      <h1>Can you see yourself?</h1>
      <p>Your camera preview is in the top-left corner. Sit so your whole face fits inside the box, at a comfortable distance from the screen.</p>
      <p>Good, even light on your face helps a lot. Avoid a bright window behind you.</p>
      <p>From here on, keep your head as still as you can — head movement after calibration is the main reason the estimate drifts.</p>
      <div class="sg-actions">
        <button class="sg-btn primary" id="sg-frame-ready">I'm in frame</button>
        <button class="sg-btn ghost" id="sg-frame-cancel">Continue without eye tracking</button>
      </div>
    </div>
  </div>
  <div class="sg-overlay sg-calib" id="sg-calib" hidden>
    <div class="sg-calib-hint" id="sg-calib-hint">
      <strong>Look at each dot and click it</strong>
      <span>Five clicks per dot, nine dots. Look straight at each dot as you click it,
      and keep your head still from here until the end — moving is what makes the estimate drift.</span>
    </div>
    <!-- Progress is shown rather than implied: a dot that cannot be
         reached would otherwise stall the step with nothing to say so. -->
    <div class="sg-calib-progress" id="sg-calib-progress"></div>
    <button class="sg-btn ghost sg-calib-skip" id="sg-calib-skip">Skip this — no eye tracking</button>
    <div class="sg-calib-skip-note">Everything works the same either way. Skipping turns the camera off.</div>
  </div>
  <button class="sg-stop" id="sg-stop" hidden><span class="rec"></span> Eye tracking on — stop</button>
  <div class="sg-overlay" id="sg-confirm" hidden>
    <div class="sg-card">
      <h1>Stop eye tracking?</h1>
      <p>Your camera turns off and nothing more is recorded. What was already measured is kept. Everything else carries on exactly as before.</p>
      <p>This cannot be turned back on for this run.</p>
      <div class="sg-actions">
        <button class="sg-btn primary" id="sg-stop-confirm">Stop and turn off the camera</button>
        <button class="sg-btn ghost" id="sg-stop-cancel">Keep tracking</button>
      </div>
    </div>
  </div>
  <div class="sg-note" id="sg-note" hidden></div>`;

  let gazeUiReady = false;
  const $g = id => document.getElementById(id);

  function ensureGazeUi() {
    if (gazeUiReady) return;
    gazeUiReady = true;
    const style = document.createElement('style');
    style.id = 'study-gaze-css';
    style.textContent = GAZE_CSS;
    // Prepended for the same reason as the task CSS: the app's own
    // stylesheet can restate the variables without !important.
    document.head.insertBefore(style, document.head.firstChild);
    document.body.insertAdjacentHTML('beforeend', GAZE_HTML);

    $g('sg-stop').addEventListener('click', () => {
      // Confirmed rather than immediate: it is one click away from the
      // app itself, and an accidental stop cannot be undone mid-run.
      gazeOverlayUp = true;
      $g('sg-confirm').hidden = false;
    });
    $g('sg-stop-cancel').addEventListener('click', () => {
      $g('sg-confirm').hidden = true;
      gazeOverlayUp = false;
    });
    $g('sg-stop-confirm').addEventListener('click', async () => {
      $g('sg-confirm').hidden = true;
      gazeOverlayUp = false;
      await stopTracking('participant used the stop control');
    });
  }

  // Resolves with the button the participant pressed: true for the first.
  function askOverlay(id, yesId, noId) {
    return new Promise(resolve => {
      const overlay = $g(id);
      const done = (yes) => { overlay.hidden = true; resolve(yes); };
      $g(yesId).addEventListener('click', () => done(true), { once: true });
      $g(noId).addEventListener('click', () => done(false), { once: true });
      overlay.hidden = false;
    });
  }

  // WebGazer trains on clicks: it pairs the face it sees with the point it
  // knows you are looking at. An untrained tracker still returns
  // confident-looking numbers — which is why skipping calibration turns
  // tracking off rather than proceeding.
  function runCalibration() {
    return new Promise(resolve => {
      const overlay = $g('sg-calib');
      const hint = $g('sg-calib-hint');
      const progress = $g('sg-calib-progress');
      overlay.querySelectorAll('.sg-dot').forEach(d => d.remove());

      const totalClicks = CALIB_POINTS.length * CALIB_CLICKS;
      let clicks = 0;
      let remaining = CALIB_POINTS.length;
      // Counts clicks, not finished dots: a full pass of one click each
      // otherwise still read "0 of 9", which looks like nothing registers.
      const showProgress = () => {
        progress.textContent =
          `${clicks} of ${totalClicks} clicks · ${CALIB_POINTS.length - remaining} of ${CALIB_POINTS.length} dots done`;
      };
      showProgress();

      CALIB_POINTS.forEach(([px, py], i) => {
        const dot = document.createElement('button');
        dot.className = 'sg-dot';
        dot.style.left = px + '%';
        dot.style.top = py + '%';
        dot.innerHTML = '<span class="fill"></span>';
        let hits = 0;
        dot.addEventListener('click', () => {
          hits += 1;
          clicks += 1;
          dot.querySelector('.fill').style.transform = `scale(${hits / CALIB_CLICKS})`;
          showProgress();
          if (i === CENTRE_POINT) hint.classList.add('dimmed');
          // Count a dot down exactly once. Relying on .done's
          // pointer-events alone is how `remaining` could skip past zero
          // and hang the step with no way forward.
          if (hits >= CALIB_CLICKS && !dot.classList.contains('done')) {
            dot.classList.add('done');
            remaining -= 1;
            showProgress();
            if (remaining <= 0) { overlay.hidden = true; resolve(true); }
          }
        });
        overlay.appendChild(dot);
      });

      $g('sg-calib-skip').addEventListener('click', () => {
        overlay.hidden = true;
        resolve(false);
      }, { once: true });

      hint.classList.remove('dimmed');
      overlay.hidden = false;
    });
  }

  // Cuts the camera itself. webgazer.end() stops its prediction loop but
  // leaves the MediaStream open, so the camera light stays on while the
  // participant is told tracking stopped. Only stopping the tracks
  // actually releases the hardware.
  function releaseCamera() {
    let stopped = 0;
    document.querySelectorAll('video').forEach(v => {
      const stream = v.srcObject;
      if (stream && stream.getTracks) {
        stream.getTracks().forEach(t => { try { t.stop(); stopped += 1; } catch {} });
      }
      v.srcObject = null;
    });
    const box = document.getElementById('webgazerVideoContainer');
    if (box) box.remove();
    return stopped;
  }

  function endWebgazer() {
    // Deliberately not awaited on its own terms: an end() that never
    // settles used to block everything queued behind it.
    Promise.race([
      Promise.resolve().then(() => window.webgazer && webgazer.end()),
      new Promise(r => setTimeout(r, 2000))
    ]).catch(err => console.warn('Tracker did not shut down cleanly:', err));
  }

  function showNote(html, detail) {
    const note = $g('sg-note');
    if (!note) return;
    note.innerHTML = html + '<code></code>';
    note.querySelector('code').textContent = detail || '';
    note.hidden = false;
  }

  // The single teardown path — the stop control, "I'm done", and any
  // failure after tracking began. Idempotent, because more than one of
  // those can fire.
  async function stopTracking(reason) {
    if (!gazeOn) return;
    gazeOn = false;
    $g('sg-stop').hidden = true;

    // Every step is wrapped: an exception anywhere in here used to vanish
    // into the caller's await, leaving the camera off, the record
    // unwritten, and nothing to say which step failed.
    const trace = [];

    // Camera first, and synchronously. Nothing slow may stand between the
    // participant asking and the light going out.
    try { trace.push(`tracks:${releaseCamera()}`); }
    catch (err) { trace.push('releaseCamera threw: ' + err.message); }
    endWebgazer();

    // Stopping is not a reason to discard what they already agreed to give.
    try { closeFixation(); trace.push(`queued:${gazeBuffer.length}`); }
    catch (err) { trace.push('closeFixation threw: ' + err.message); }
    try { await flushGaze(); trace.push('flushed'); }
    catch (err) { trace.push('flush threw: ' + err.message); }

    // The session row was written long before this, so this is the one
    // piece of state that has to be an update — via a function, not a
    // direct update: an anon client cannot see the row it would update,
    // so a plain update matches nothing and still reports success. The
    // function returns rows changed, so "it worked" can be checked.
    if (!window.supabaseClient) {
      trace.push('no db client');
    } else if (gazeState !== 'tracking') {
      trace.push(`state was "${gazeState}", not "tracking" — nothing to update`);
    } else {
      const sid = sessionId, ready = sessionReady;
      gazeState = 'stopped';
      try {
        await ready;
        const { data, error } = await supabaseClient.rpc('stop_gaze', { sid });
        trace.push(error ? `stop_gaze failed: ${error.message}`
                         : (data === 1 ? 'recorded' : `no row changed (returned ${data})`));
        if (error) console.error('could not record the stop', error);
      } catch (err) {
        trace.push('update threw: ' + err.message);
        console.error('could not record the stop', err);
      }
    }

    const detail = trace.join(' · ');
    console.info(`Eye tracking stopped (${reason}): ${detail}`);
    showNote('Eye tracking stopped. Your camera is off.', DEBUG ? detail : '');
  }

  // Resolves to the gaze_state to record. Never throws: eye tracking is
  // an extra, and nothing it can do may stop the study from running.
  async function setUpGaze() {
    if (!gazeSupported()) return 'unsupported';

    ensureGazeUi();
    gazeOverlayUp = true;
    try {
      if (!await askOverlay('sg-consent', 'sg-allow', 'sg-decline')) return 'declined';

      await loadScript(GAZE_LIB);

      // Both must be set before begin(): the path is read when the face
      // mesh is constructed. And another session's training data was
      // fitted to a different face, at a different distance and light.
      webgazer.params.faceMeshSolutionPath = FACE_MESH_PATH;
      webgazer.params.saveDataAcrossSessions = false;

      // begin() opens the camera, which is where a browser-level denial
      // surfaces — caught below and recorded as 'blocked'.
      await webgazer
        .setRegression('ridge')
        .setGazeListener(onGazeSample)
        .showPredictionPoints(false)
        .begin();

      // WebGazer trains on every click anywhere on the page, into a ring
      // buffer of 50. The framing button and anything else before the
      // dots are clicks the participant was not necessarily looking at.
      // Training is switched on only for the dots themselves.
      try { webgazer.removeMouseEventListeners(); } catch {}

      webgazer.showVideoPreview(true).showFaceOverlay(true).showFaceFeedbackBox(true);

      if (!await askOverlay('sg-frame', 'sg-frame-ready', 'sg-frame-cancel')) {
        releaseCamera();
        endWebgazer();
        return 'calibrating';
      }

      // The preview goes before the dots appear: it sits on top of the
      // top-left dot, and a moving image pulls the eye at the one moment
      // gaze has to be on a known point.
      webgazer.showVideoPreview(false).showFaceOverlay(false).showFaceFeedbackBox(false);
      try { webgazer.addMouseEventListeners(); } catch {}

      if (!await runCalibration()) {
        // The skip button said the camera turns off, so it has to.
        releaseCamera();
        endWebgazer();
        return 'calibrating';
      }

      // Freeze the fit the moment calibration ends. With 45 calibration
      // samples in a 50-slot buffer, the first study clicks would start
      // overwriting the dots the participant carefully looked at — and a
      // study click is a poor sample anyway: they may be looking anywhere.
      try {
        webgazer.removeMouseEventListeners();
        // A count that grows after this means the detach did not take; one
        // that holds while accuracy falls away means drift — opposite fixes.
        window.__frozenAt = trainingSamples();
      } catch (err) {
        window.__frozenAt = 'detach failed';
        console.warn('could not stop click training', err);
      }

      // In debug mode, show WebGazer's own prediction dot: stored
      // fixations cannot tell a mirrored axis from a bad calibration from
      // plain noise, and watching the raw estimate separates all three.
      if (DEBUG) webgazer.showPredictionPoints(true);

      gazeOn = true;
      return 'tracking';
    } catch (err) {
      // Surfaced on screen, not just logged: silent for participants also
      // made a setup failure impossible to tell apart from a "no".
      console.warn('Eye tracking unavailable:', err);
      window.__gazeError = err;
      showNote('Eye tracking could not start. Everything else still works — this note is for setup only.',
        [(err && err.name ? err.name + ': ' : '') + ((err && err.message) || String(err)),
         ...String((err && err.stack) || '').split('\n').slice(0, 5)].join('\n'));
      try { releaseCamera(); } catch {}
      endWebgazer();
      // Recorded apart because each calls for a different response: a
      // blocked camera is a permission the participant can grant, a failed
      // library is ours to fix, and a decline is neither.
      const denied = err && ['NotAllowedError', 'SecurityError', 'NotFoundError', 'NotReadableError']
        .includes(err.name);
      return denied ? 'blocked' : 'unavailable';
    } finally {
      gazeOverlayUp = false;
    }
  }

  // Everything that keeps a live tracker honest once the session exists:
  // the stop control, the periodic flush, and sending what is buffered
  // when the page goes away.
  function startGazeUpkeep() {
    $g('sg-stop').hidden = false;
    setInterval(flushGaze, GAZE_FLUSH_MS);
    // A closing tab kills in-flight requests, so send while the page is
    // still alive. 'pagehide' fires where 'unload' is unreliable (bfcache,
    // mobile Safari). The open fixation is finished here, unlike on the
    // timer: the page is going, so the look is over.
    const finish = () => { closeFixation(); flushGaze(); };
    window.addEventListener('pagehide', finish);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') finish();
    });

    // Opt-in live readout. Whether clustering works is otherwise invisible
    // until the run is over and the rows are queried.
    if (DEBUG) {
      showNote('Gaze debug', '');
      setInterval(() => {
        const code = document.querySelector('#sg-note code');
        if (!code) return;
        const g = window.__lastGaze;
        code.textContent =
          `${gazeSamples} raw · ${gazeSent} sent · ${gazeDropped} dropped · ${gazeBuffer.length} queued`
          + ` · recording ${gazeWanted() ? 'yes' : 'no'}\n`
          + (g ? `raw ${Math.round(g.x)},${Math.round(g.y)} of ${innerWidth}x${innerHeight}`
                 + ` -> box ${g.cx.toFixed(2)},${g.cy.toFixed(2)}`
               : 'no prediction yet')
          + `\ntrained on ${trainingSamples()}`
          + (window.__frozenAt != null ? ` · frozen at ${window.__frozenAt}` : '');
      }, 500);
    }
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
    previewState,
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
    get gazeState() { return gazeState; },
    get gazeOn()    { return gazeOn; },

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
