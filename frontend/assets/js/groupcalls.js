/**
 * Group audio calling: a small-group WebRTC MESH built on top of the same
 * REST/JWT signaling relay, ICE config, and polling architecture calls.js
 * already established for 1:1 calling — see backend/routers/calls.py's
 * "--- Group audio calling ---" section and backend/models.py's Call.scope
 * docstring for the backend half of this split.
 *
 * Mesh, not an SFU: with N participants, EVERY participant keeps one
 * RTCPeerConnection open to every OTHER participant (N*(N-1)/2 pairs
 * total), each carrying just that pair's local mic track and that peer's
 * remote audio. That's why config.GROUP_CALL_MAX_PARTICIPANTS caps this at
 * a small number (default 6, enforced server-side) — a real meeting-sized
 * call needs a media server (an SFU) that each participant sends ONE stream
 * to instead; that's a materially different architecture and explicitly out
 * of scope for this first iteration.
 *
 * Deliberately a SEPARATE module/poll-loop/state machine from calls.js
 * rather than folding group calling into it: a 1:1 call has exactly one
 * peer connection and one "the other person" — bolting a Map of peers onto
 * that state machine would mean rewriting calls.js's well-tested
 * offer/answer/mute/cleanup logic to be N-aware everywhere, for a feature
 * that (per isActive() below) can never even be active at the same time as
 * a 1:1 call. Two small, independent modules is safer than one large,
 * conditionally-N-aware one.
 *
 * PING conversations are always exactly 2 people (see
 * backend/services/conversation_service.py's docstring) — there's no
 * "group conversation" to draw a member list from. So a group call's
 * roster is built explicitly: the conversation's other member is always
 * included (same "the call button in this chat calls this person"
 * convention as calls.js), plus whichever additional CONTACTS (people the
 * creator already has some direct conversation with — see
 * openStartModal/loadContacts) the creator explicitly picks when starting
 * the call. The backend independently re-validates every one of those
 * contacts (has_direct_conversation) — this module's picker is a UI
 * convenience, never the actual authorization boundary.
 *
 * Offer/answer glare is avoided with a fixed rule instead of a "perfect
 * negotiation" dance: for any pair (A, B), whoever has the LOWER user id
 * always creates the offer (see shouldInitiateTo) — both sides apply the
 * exact same rule independently (from their own reconcileParticipants pass,
 * whenever they first see the other as "joined"), so exactly one offer ever
 * gets created per pair, with no signal needed to negotiate who negotiates.
 *
 * One peer's failure (ICE failed) only tears down THAT one
 * RTCPeerConnection (see markPeerFailed/teardownPeer) — the next poll's
 * reconcileParticipants sees the server still lists them "joined" and
 * automatically retries connectToParticipant for them, which is also how
 * "allow reconnection if practical" is satisfied with no separate retry
 * logic. Every other participant's connection is completely untouched.
 *
 * Screen sharing extends this same mesh: the one active sharer's captured
 * track is added as a SECOND, independent sender on every peer connection
 * (mirroring how calls.js's 1:1 screen share adds a second track to its one
 * connection — see that module's own docstring) — never a second call, never
 * a second signaling channel. Exactly one person may share at a time,
 * enforced SERVER-SIDE (backend/models.Call.screen_sharing_user_id, via
 * services/call_service.start_group_screen_share's 409-on-conflict) rather
 * than trusted from any client's own belief — every participant's poll
 * response (GroupCallOut.screen_share) carries that authoritative fact,
 * reconciled into state.activeSharerId by syncScreenShareState, with the
 * broadcast 'screen-share-state' signal (peer_user_id=None, same shape as
 * 'mute-state' above) layered on top purely so the OTHER participants'
 * viewers update the instant the sharer toggles instead of waiting out a
 * poll tick.
 *
 * Per the task's explicit requirement, there is NO global negotiation flag
 * for screen sharing — each entry in state.peers carries its OWN
 * `negotiating` state (see negotiateWithPeer/settlePeerNegotiation), reused
 * for BOTH a peer's very first (base call) offer/answer exchange and any
 * later screen-share-add renegotiation to that SAME peer, with a one-deep
 * queue (`pendingNegotiation`) so a second request arriving mid-negotiation
 * waits for the first to settle instead of ever starting a second, invalid,
 * concurrent local negotiation on one RTCPeerConnection. Only the ACTIVE
 * SHARER's side ever initiates a screen-track-adding renegotiation (viewers
 * never renegotiate anything themselves) — combined with the fixed
 * shouldInitiateTo rule already governing the base offer, this means two
 * sides never race to renegotiate the SAME peer connection at once, so
 * (unlike calls.js's 1:1 screen share) no polite/impolite glare-rollback
 * dance is needed here.
 *
 * Stopping a share never renegotiates (task allows "remove or replace" —
 * this always replaces): replaceTrack(null) on every peer's kept sender,
 * exactly like calls.js's own stopScreenShare, so a later re-share the same
 * call reuses the same senders. A peer's sender/remote-screen-track live
 * entirely on that peer's own state.peers entry (never a single shared
 * variable) — see createPeerConnectionFor — so one peer connection failing
 * mid-share (teardownPeer) only ever loses that ONE peer's copy of the
 * shared screen; every other peer's is completely unaffected, satisfying
 * the same per-peer failure isolation the base audio mesh already has.
 *
 * Camera video extends this SAME mesh the same way screen sharing does —
 * one MORE independent track/sender per peer connection, added/removed via
 * the identical negotiateWithPeer/addTrack/replaceTrack(null) machinery
 * (see startCamera/stopCamera/addCameraTrackToPeer) — never a second
 * connection, never a second signaling channel. The key difference from
 * screen sharing: camera has no server-enforced "one at a time" slot — any
 * number of participants may have a camera on simultaneously (up to the
 * existing participant cap), so there's no models.Call column to reconcile
 * against. Each participant's camera on/off is tracked purely via the
 * broadcast 'camera-state' signal (same shape/reasoning as 'mute-state' —
 * see schemas.CALL_SIGNAL_TYPES's docstring) into that participant's own
 * state.participants entry, rendered as a responsive grid of video tiles
 * (renderCameraGrid) alongside — never instead of — the existing
 * audio-participant list and the screen-share viewer. Because a peer
 * connection can now carry a camera track AND a screen-share track AND
 * audio at once, each renegotiation's offer carries a small extra
 * `videoKind: 'camera' | 'screen'` field (see negotiateWithPeer's
 * `offerExtras` param) purely so the RECEIVING side's ontrack can tell the
 * two kinds of incoming video apart — WebRTC's own ontrack event has no
 * such notion built in, and unlike screen sharing (server-authoritative)
 * there's nothing else to disambiguate against for camera.
 *
 * Surviving a page refresh: a reload destroys this whole module's JS state
 * (every RTCPeerConnection, localStream, everything in `state`) — that part
 * is unavoidable. What's NOT unavoidable is treating that reload as
 * LEAVING the call: there is deliberately no pagehide/beforeunload/
 * visibilitychange handler here (an earlier version had one that POSTed
 * .../leave on pagehide, but that event fires identically on a real tab
 * close and on a plain refresh — there's no way to tell those apart at the
 * browser-event level, so "detect a refresh" was never the right fix).
 * Instead, GroupCalls.init()'s very first poll (see pollForIncoming) checks
 * whether the server still lists this user's OWN participant row as
 * 'joined' — true whenever this is a reload mid-call, since nothing set it
 * to 'left' — and if so calls resumeActiveCall() instead of showing the
 * incoming-invitation banner: re-acquire the mic, re-POST the (idempotent)
 * .../join, then hand off to the SAME enterActiveCall() a fresh join
 * already uses. From there the mesh rebuilds itself with no new code at
 * all: reconcileParticipants already calls connectToParticipant for every
 * peer still listed 'joined' that this side has no live RTCPeerConnection
 * for — originally built for ICE-failure retry, and it turns out that's
 * exactly what "reconnect after reload" needs too. A participant who
 * genuinely closes their tab for good (not a refresh) is instead caught
 * server-side, lazily, once their last_activity_at goes stale past
 * config.GROUP_CALL_ABANDON_TIMEOUT_SECONDS — see
 * services/call_service.apply_group_call_abandonment.
 */
const GroupCalls = (function ($) {
  'use strict';

  // Local tuning constant (not shared with any other module, unlike the
  // poll intervals in config.js) — a 0-255 average frequency-bin energy
  // above this is treated as "speaking". Mic-dependent and approximate;
  // see startSpeakingDetection's docstring for why this is LOCAL-ONLY.
  const SPEAKING_THRESHOLD = 12;

  const state = {
    currentUser: null,
    iceServers: null,
    // idle | incoming | resuming | active
    // "incoming": invited to a call, banner shown, not yet joined (no local
    // media acquired yet — same "never touch the mic before the user acts"
    // rule calls.js follows for an incoming 1:1 call).
    // "resuming": transitional only, set synchronously by resumeActiveCall
    // right before its own acquireLocalMedia() — the server already lists
    // us 'joined' (a page reload, never an invitation), so there's no
    // banner for this one; it exists purely so isActive() still reports
    // true during that async gap (blocking a concurrent 1:1/group call
    // start) without rendering a bar/panel before there's anything real to
    // show one for. Always resolves to 'active' (enterActiveCall) or back
    // to 'idle' (resume failed — see resumeActiveCall's catch).
    // "active": joined (or the creator, who auto-joins) — mic acquired,
    // bar + participant panel shown.
    phase: 'idle',
    callId: null,
    conversationId: null,
    creatorId: null,
    localStream: null,
    muted: false,
    localSpeaking: false,
    // userId -> { user, status: 'invited'|'joined', muted, cameraOn,
    // connectionState: 'connecting'|'connected'|'failed'|null }
    // Built fresh from every poll's participants list (see
    // reconcileParticipants) — server-authoritative except muted/cameraOn
    // (reconciled from the broadcast 'mute-state'/'camera-state' signals —
    // neither has any server-side column, see models.CallSignal's
    // docstring) and connectionState (this client's own WebRTC-level view
    // of that peer).
    participants: new Map(),
    // userId -> { pc, pendingCandidates, negotiating, pendingNegotiation,
    // pendingAnswerResolve, pendingAnswerReject, answerTimeout,
    // pendingIncomingVideoKind, screenSender, remoteScreenTrack,
    // remoteScreenStream, cameraSender, remoteCameraTrack,
    // remoteCameraStream }. One entry per OTHER participant this side
    // currently has (or is establishing) a live RTCPeerConnection with —
    // never one per signal, never one shared connection for the whole call.
    // See negotiateWithPeer for the per-peer (never global) negotiation
    // fields, and the module docstring's screen-sharing/camera paragraphs
    // for the rest.
    peers: new Map(),
    lastSignalId: 0,
    // --- Screen sharing (see module docstring) ---------------------------
    // This side's own outgoing share, if any — entirely separate from
    // localStream (the microphone) above, same "never coupled" posture
    // calls.js's screen sharing already follows.
    localScreenStream: null,
    localScreenTrack: null,
    sharingScreen: false,
    // True from the moment the "Share Screen" click fires the REST claim
    // request until getDisplayMedia resolves/rejects — guards a rapid
    // double-click from firing two claim requests, and disables the button
    // meanwhile (see renderScreenShareButton).
    startingScreenShare: false,
    // The server-authoritative current sharer's user id, or null — kept in
    // sync with the polled GroupCallOut.screen_share (syncScreenShareState)
    // and nudged early by the 'screen-share-state' broadcast signal/the
    // first video ontrack from that peer, for a snappier UI than waiting out
    // a full poll tick. NEVER itself the authorization boundary — that's
    // always the backend's 409 on a conflicting claim.
    activeSharerId: null,
    // UI-only (mirrors calls.js's state.screenViewerExpanded): whether the
    // remote screen-share viewer is showing enlarged. Independent per
    // browser tab by construction — never signaled/persisted — so each
    // participant's expand/collapse is already isolated with no extra code.
    screenViewerExpanded: false,
    // --- Camera (see module docstring) -----------------------------------
    // This side's own outgoing camera track, if any — entirely separate
    // from localStream (the microphone) above, same "never coupled" posture
    // toggleMute/toggleCamera already establish for a 1:1 call in calls.js.
    localCameraStream: null,
    localCameraTrack: null,
    cameraOn: false,
    // True from the click until getUserMedia resolves/rejects — guards a
    // rapid double-click the same way startingScreenShare does for sharing.
    startingCamera: false,
    // Bumped on every teardown, same "invalidate in-flight requests for the
    // call that just ended" guard calls.js's pollGeneration provides.
    pollGeneration: 0,
    pollTimer: null,
    idlePollInFlight: false,
    activePollInFlight: false,
    // A call id the user explicitly dismissed from the incoming banner —
    // skipped by future idle polls so a dismissed invitation doesn't just
    // reappear on the next tick (see pollForIncoming). Reset the moment a
    // DIFFERENT call becomes active for this user.
    dismissedCallId: null,
    panelOpen: false,
    audioContext: null,
    analyser: null,
    analyserData: null,
    speakingRaf: null,
    // The modal's own transient selection state — cleared on close/confirm,
    // never persisted, same "render flag, not fetched state" reasoning
    // chat.js's replyTo uses.
    modalConversationId: null,
    modalOtherUser: null,
    modalSelected: new Set(),
    // --- Add People (mid-call) modal — see openAddPeopleModal. A SEPARATE
    // selection Set from modalSelected above (different modal, different
    // lifetime) holding {id -> user} rather than just ids, since a pick can
    // scroll out of the current search RESULTS (a later query for a
    // different name) while still needing to render as selected/counted —
    // see renderAddPeopleHint. Never persisted beyond the modal's own
    // open/close, same as modalSelected.
    addPeopleSelected: new Map(),
    addPeopleSearchSeq: 0,
    addPeopleDebounceTimer: null,
    addingPeople: false
  };

  let $appShell;
  let $banner, $bannerAvatar, $bannerCreator, $dismissBtn, $joinBtn;
  let $bar, $barCount, $muteBtn, $cameraBtn, $peopleBtn, $endBtn, $leaveBtn;
  let $panel, $panelList, $panelClose;
  let $audioContainer;
  let $modalOverlay, $modalHint, $modalList, $modalCancelBtn, $modalConfirmBtn, $modalCloseBtn;
  // Screen sharing — see the module docstring's screen-sharing paragraphs.
  let $screenShareBtn, $sharingIndicator, $sharingIndicatorText;
  let $screenPanel, $screenVideo, $screenExpandBtn;
  // Camera — see the module docstring's camera paragraph.
  let $videoGrid;
  // Add People (mid-call) — see openAddPeopleModal.
  let $addPeopleBtn, $addPeopleModalOverlay, $addPeopleSearchInput, $addPeopleHint, $addPeopleList;
  let $addPeopleCancelBtn, $addPeopleConfirmBtn, $addPeopleModalCloseBtn;

  function init(currentUser) {
    state.currentUser = currentUser;

    $appShell = $('#appShell');
    $banner = $('#groupCallBanner');
    $bannerAvatar = $('#groupCallBannerAvatar');
    $bannerCreator = $('#groupCallBannerCreator');
    $dismissBtn = $('#groupCallDismissBtn');
    $joinBtn = $('#groupCallJoinBtn');

    $bar = $('#groupCallBar');
    $barCount = $('#groupCallBarCount');
    $muteBtn = $('#groupCallMuteBtn');
    $cameraBtn = $('#groupCallCameraBtn');
    $peopleBtn = $('#groupCallPeopleBtn');
    $endBtn = $('#groupCallEndBtn');
    $leaveBtn = $('#groupCallLeaveBtn');

    $panel = $('#groupCallPanel');
    $panelList = $('#groupCallParticipantList');
    $panelClose = $('#groupCallPanelClose');

    $audioContainer = $('#groupCallAudioContainer');

    $screenShareBtn = $('#groupCallScreenShareBtn');
    $sharingIndicator = $('#groupCallSharingIndicator');
    $sharingIndicatorText = $('#groupCallSharingIndicatorText');
    $screenPanel = $('#groupCallScreenPanel');
    $screenVideo = $('#groupCallScreenVideo');
    $screenExpandBtn = $('#groupCallScreenExpandBtn');

    $videoGrid = $('#groupCallVideoGrid');

    $modalOverlay = $('#groupCallStartModalOverlay');
    $modalHint = $('#groupCallStartModalHint');
    $modalList = $('#groupCallContactList');
    $modalCancelBtn = $('#groupCallStartCancelBtn');
    $modalConfirmBtn = $('#groupCallStartConfirmBtn');
    $modalCloseBtn = $('#groupCallStartModalClose');

    $addPeopleBtn = $('#groupCallAddPeopleBtn');
    $addPeopleModalOverlay = $('#groupCallAddPeopleModalOverlay');
    $addPeopleSearchInput = $('#groupCallAddPeopleSearchInput');
    $addPeopleHint = $('#groupCallAddPeopleHint');
    $addPeopleList = $('#groupCallAddPeopleList');
    $addPeopleCancelBtn = $('#groupCallAddPeopleCancelBtn');
    $addPeopleConfirmBtn = $('#groupCallAddPeopleConfirmBtn');
    $addPeopleModalCloseBtn = $('#groupCallAddPeopleModalClose');

    $joinBtn.on('click', joinIncoming);
    $dismissBtn.on('click', dismissIncoming);
    $muteBtn.on('click', toggleMute);
    $cameraBtn.on('click', toggleCamera);
    $peopleBtn.on('click', togglePanel);
    $panelClose.on('click', togglePanel);
    $leaveBtn.on('click', leaveCall);
    $endBtn.on('click', endCallForEveryone);

    $screenShareBtn.on('click', toggleScreenShare);
    $screenExpandBtn.on('click', toggleScreenViewerExpanded);

    $addPeopleBtn.on('click', openAddPeopleModal);
    $addPeopleCancelBtn.on('click', closeAddPeopleModal);
    $addPeopleModalCloseBtn.on('click', closeAddPeopleModal);
    $addPeopleConfirmBtn.on('click', confirmAddPeople);
    $addPeopleSearchInput.on('input', onAddPeopleSearchInput);

    // Only collapses an EXPANDED screen viewer — mirrors calls.js's own
    // document-level Escape handler for its 1:1 viewer (never interferes
    // with chat.js's own Escape handling for its emoji picker/edit-cancel,
    // same reasoning calls.js's copy already documents).
    $(document).on('keydown', function (e) {
      if (e.key === 'Escape' && state.screenViewerExpanded) {
        collapseScreenViewer();
      }
    });

    $modalCancelBtn.on('click', closeStartModal);
    $modalCloseBtn.on('click', closeStartModal);
    $modalConfirmBtn.on('click', confirmStartCall);

    // Reuses the SAME ice-servers endpoint/cache convention calls.js
    // established — fetched independently here (not shared via a getter)
    // since these two modules otherwise know nothing about each other,
    // same "self-contained like forward.js/media.js" posture as calls.js's
    // own module docstring.
    Api.request({ url: '/calls/ice-servers' })
      .done(function (response) { state.iceServers = response.ice_servers; })
      .fail(function () { state.iceServers = DEFAULT_ICE_SERVERS; });

    // Polled immediately rather than merely scheduled — this is also the
    // "was I already joined to an active call before this reload?" resume
    // check (see pollForIncoming), so a refreshed participant shouldn't
    // have to wait out one full GROUP_CALL_POLL_INTERVAL_IDLE_MS tick
    // before reconnecting. Same "don't make the user wait" reasoning
    // showIncoming/joinIncoming already use for their own pollCallState().
    pollForIncoming();
  }

  function rtcSupported() {
    return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function isActive() {
    return state.phase !== 'idle';
  }

  // --- Polling --------------------------------------------------------
  // One timer for the whole feature, exactly like calls.js's own single
  // pollTimer — never one per participant/peer connection (task
  // requirement). Idle speed just checks for an invitation; active speed
  // (once genuinely joined) carries signaling + the live participant list.

  const ACTIVE_SPEED_PHASES = { active: true };

  function scheduleNextPoll() {
    clearTimeout(state.pollTimer);
    const delay = ACTIVE_SPEED_PHASES[state.phase] ? GROUP_CALL_POLL_INTERVAL_ACTIVE_MS : GROUP_CALL_POLL_INTERVAL_IDLE_MS;
    state.pollTimer = setTimeout(pollTick, delay);
  }

  function pollTick() {
    if (!state.callId) {
      pollForIncoming();
    } else {
      pollCallState();
    }
  }

  function pollForIncoming() {
    if (state.idlePollInFlight) {
      scheduleNextPoll();
      return;
    }
    state.idlePollInFlight = true;

    Api.request({ url: '/calls/group/active' })
      .done(function (response) {
        if (state.phase !== 'idle') return; // a call started/joined locally in the meantime
        if (response.call && response.call.id !== state.dismissedCallId) {
          // Tell an actual incoming invitation apart from "I was already
          // joined to this before the page reloaded" — the server still
          // lists a resuming participant's own row as 'joined' (see
          // models.CallParticipant.last_activity_at's docstring: refresh no
          // longer forces a leave), so no banner/click is needed for them,
          // unlike someone freshly invited (still 'invited', never joined).
          const myEntry = response.call.participants.filter(function (p) {
            return p.user.id === state.currentUser.id;
          })[0];
          if (myEntry && myEntry.status === 'joined') {
            resumeActiveCall(response.call);
            return; // resumeActiveCall's own poll (via enterActiveCall) takes over from here
          }
          showIncoming(response.call);
          return; // pollCallState takes over from here
        }
        scheduleNextPoll();
      })
      .fail(function () {
        if (state.phase === 'idle') scheduleNextPoll();
      })
      .always(function () {
        state.idlePollInFlight = false;
      });
  }

  function pollCallState() {
    if (state.activePollInFlight) {
      scheduleNextPoll();
      return;
    }
    state.activePollInFlight = true;
    const callId = state.callId;
    const generation = state.pollGeneration;

    Api.request({ url: '/calls/group/' + callId + '?after_signal_id=' + state.lastSignalId })
      .done(function (response) {
        if (generation !== state.pollGeneration) return;
        handleCallUpdate(response.call, response.signals);
      })
      .fail(function (xhr) {
        if (generation !== state.pollGeneration) return;
        if (xhr.status === 403 || xhr.status === 404) {
          teardownToIdle('This group call is no longer available.');
        }
        // Any other failure: transient network blip, next tick retries —
        // same silent-on-poll-failure posture as calls.js/chat.js.
      })
      .always(function () {
        state.activePollInFlight = false;
        if (generation === state.pollGeneration) scheduleNextPoll();
      });
  }

  function handleCallUpdate(call, signals) {
    signals.forEach(function (signal) {
      state.lastSignalId = Math.max(state.lastSignalId, signal.id);
      handleSignal(signal.sender_id, signal);
    });

    if (call.status === 'ended') {
      teardownToIdle(state.phase === 'active' ? 'Group call ended' : 'The group call ended before you joined.');
      return;
    }

    reconcileParticipants(call.participants);
    syncScreenShareState(call.screen_share);
    render();
  }

  // --- Starting a call --------------------------------------------------

  function acquireLocalMedia() {
    return navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }

  function mediaErrorMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Microphone permission is required to join a group call.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No microphone was found on this device.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Your microphone could not be accessed — it may be in use by another application.';
    }
    if (err && err.responseJSON && err.responseJSON.message) {
      return err.responseJSON.message;
    }
    return 'Unable to join the group call.';
  }

  /** Opens the participant picker. otherUser is the conversation's other
   * member — always included, never shown as a pickable checkbox (see the
   * module docstring's "the call button in this chat calls this person"
   * convention). Additional contacts come from the creator's own
   * conversations, fetched fresh each time the modal opens. */
  function openStartModal(conversationId, otherUser) {
    if (isActive()) {
      Ping.showToast('You are already in a group call.', 'error');
      return;
    }
    if (Calls.isActive()) {
      Ping.showToast('You are already on a call.', 'error');
      return;
    }
    if (!rtcSupported()) {
      Ping.showToast('Your browser does not support group calls.', 'error');
      return;
    }

    state.modalConversationId = conversationId;
    state.modalOtherUser = otherUser;
    state.modalSelected = new Set();

    $modalList.empty().text('Loading your conversations…');
    $modalOverlay.prop('hidden', false);
    renderModalHint();

    Api.request({ url: '/conversations' })
      .done(function (response) {
        renderContactList(response.conversations, otherUser.id);
      })
      .fail(function () {
        $modalList.empty().text('Unable to load your conversations.');
      });
  }

  function closeStartModal() {
    $modalOverlay.prop('hidden', true);
    state.modalConversationId = null;
    state.modalOtherUser = null;
    state.modalSelected = new Set();
  }

  function maxExtraSelectable() {
    return GROUP_CALL_MAX_PARTICIPANTS - 2; // creator + the always-included other member
  }

  function renderModalHint() {
    const remaining = maxExtraSelectable() - state.modalSelected.size;
    $modalHint.text(
      state.modalOtherUser.name + ' is included automatically. Add up to ' + maxExtraSelectable() +
      ' more people (' + Math.max(0, remaining) + ' left).'
    );
  }

  function renderContactList(conversations, excludeUserId) {
    $modalList.empty();
    const contacts = conversations
      .map(function (c) { return c.other_user; })
      .filter(function (u) { return u.id !== excludeUserId; });

    if (contacts.length === 0) {
      $modalList.text('You have no other conversations to add people from.');
      return;
    }

    contacts.forEach(function (user) {
      const $item = $('<label>', { class: 'group-call-contact-item' });
      const $checkbox = $('<input>', { type: 'checkbox', value: user.id });
      $checkbox.on('change', function () {
        if (this.checked) {
          if (state.modalSelected.size >= maxExtraSelectable()) {
            this.checked = false;
            Ping.showToast('Group calls are limited to ' + GROUP_CALL_MAX_PARTICIPANTS + ' participants.', 'error');
            return;
          }
          state.modalSelected.add(user.id);
        } else {
          state.modalSelected.delete(user.id);
        }
        renderModalHint();
      });
      const $avatar = $('<span>', { class: 'avatar avatar--sm' });
      Avatars.apply($avatar, user.name, user.avatar_url);
      $item.append($checkbox, $avatar, $('<span>', { class: 'group-call-contact-item__name', text: user.name }));
      $modalList.append($item);
    });
  }

  function confirmStartCall() {
    if (!state.modalConversationId) return;
    const conversationId = state.modalConversationId;
    const participantIds = Array.from(state.modalSelected);
    closeStartModal();
    startGroupCall(conversationId, participantIds);
  }

  // --- Add People (mid-call) -----------------------------------------------
  // A SEPARATE modal/search from openStartModal above — see index.html's
  // comment on #groupCallAddPeopleModalOverlay for why this one searches
  // the whole company (GET /users/search, the same endpoint the sidebar's
  // own "start a new conversation" search already uses — see users.js)
  // rather than only the creator's existing conversations. Deliberately
  // NOT calling Users.init() to reuse that module directly: it's already
  // permanently bound to the sidebar's own #userSearchInput/#searchResults
  // and shares one module-level debounce/request-sequence pair — wiring a
  // SECOND independent search through the same shared state would risk one
  // search's in-flight request clobbering the other's if both happened to
  // be used around the same time. Same debounce/min-length feel as
  // users.js, just a self-contained copy.

  const ADD_PEOPLE_DEBOUNCE_MS = 300;
  const ADD_PEOPLE_MIN_QUERY_LENGTH = 2;

  function currentRosterCount() {
    // state.participants only ever holds invited/joined rows (a 'left'
    // participant is deleted from it outright — see reconcileParticipants),
    // so its size IS the live roster count the cap applies to.
    return state.participants.size;
  }

  function remainingAddPeopleSlots() {
    return GROUP_CALL_MAX_PARTICIPANTS - currentRosterCount();
  }

  function openAddPeopleModal() {
    if (state.phase !== 'active' || !state.callId) return;
    if (remainingAddPeopleSlots() <= 0) {
      Ping.showToast('Group calls are limited to ' + GROUP_CALL_MAX_PARTICIPANTS + ' participants.', 'error');
      return;
    }

    state.addPeopleSelected = new Map();
    $addPeopleSearchInput.val('');
    $addPeopleList.empty().text('Type at least ' + ADD_PEOPLE_MIN_QUERY_LENGTH + ' characters to search for people to add.');
    $addPeopleModalOverlay.prop('hidden', false);
    renderAddPeopleHint();
    $addPeopleSearchInput.trigger('focus');
  }

  function closeAddPeopleModal() {
    $addPeopleModalOverlay.prop('hidden', true);
    clearTimeout(state.addPeopleDebounceTimer);
    state.addPeopleSearchSeq++; // invalidate any in-flight search response
    state.addPeopleSelected = new Map();
  }

  function renderAddPeopleHint() {
    const remaining = remainingAddPeopleSlots() - state.addPeopleSelected.size;
    $addPeopleHint.text(
      state.addPeopleSelected.size + (state.addPeopleSelected.size === 1 ? ' person selected' : ' people selected') +
      ' (' + Math.max(0, remaining) + ' of ' + remainingAddPeopleSlots() + ' slots left).'
    );
  }

  function onAddPeopleSearchInput() {
    const query = $addPeopleSearchInput.val().trim();
    clearTimeout(state.addPeopleDebounceTimer);

    if (query.length < ADD_PEOPLE_MIN_QUERY_LENGTH) {
      state.addPeopleSearchSeq++; // invalidate any in-flight request's response
      $addPeopleList.empty().text('Type at least ' + ADD_PEOPLE_MIN_QUERY_LENGTH + ' characters to search for people to add.');
      return;
    }

    state.addPeopleDebounceTimer = setTimeout(function () {
      runAddPeopleSearch(query);
    }, ADD_PEOPLE_DEBOUNCE_MS);
  }

  function runAddPeopleSearch(query) {
    const seq = ++state.addPeopleSearchSeq;
    $addPeopleList.empty().text('Searching…');

    Api.request({ url: '/users/search?q=' + encodeURIComponent(query) })
      .done(function (response) {
        if (seq !== state.addPeopleSearchSeq) return; // a newer search superseded this one
        renderAddPeopleResults(response.users);
      })
      .fail(function (xhr) {
        if (seq !== state.addPeopleSearchSeq) return;
        $addPeopleList.empty().text(Ping.getErrorMessage(xhr, 'Search failed. Please try again.'));
      });
  }

  /** Renders search results filtered down to ELIGIBLE candidates only (task
   * requirement) — anyone already an active (invited/joined) participant is
   * excluded outright, never shown greyed-out, since GET /users/search
   * already excludes the searcher themselves server-side. The remaining
   * participant-limit is enforced the same way openStartModal's own
   * checkbox handler already does: a click that would exceed it is
   * rejected with a toast rather than the list being pre-filtered by
   * count, since the count changes as THIS modal's own selection grows. */
  function renderAddPeopleResults(users) {
    $addPeopleList.empty();
    const eligible = users.filter(function (u) { return !state.participants.has(u.id); });

    if (eligible.length === 0) {
      $addPeopleList.text('No eligible people found matching your search.');
      return;
    }

    eligible.forEach(function (user) {
      const $item = $('<label>', { class: 'group-call-contact-item' });
      const $checkbox = $('<input>', { type: 'checkbox', value: user.id });
      $checkbox.prop('checked', state.addPeopleSelected.has(user.id));
      $checkbox.on('change', function () {
        if (this.checked) {
          if (state.addPeopleSelected.size >= remainingAddPeopleSlots()) {
            this.checked = false;
            Ping.showToast('Group calls are limited to ' + GROUP_CALL_MAX_PARTICIPANTS + ' participants.', 'error');
            return;
          }
          state.addPeopleSelected.set(user.id, user);
        } else {
          state.addPeopleSelected.delete(user.id);
        }
        renderAddPeopleHint();
      });
      const $avatar = $('<span>', { class: 'avatar avatar--sm' });
      Avatars.apply($avatar, user.name, user.avatar_url);
      $item.append($checkbox, $avatar, $('<span>', { class: 'group-call-contact-item__name', text: user.name }));
      $addPeopleList.append($item);
    });
  }

  function confirmAddPeople() {
    if (!state.callId || state.addPeopleSelected.size === 0 || state.addingPeople) return;
    const callId = state.callId;
    const userIds = Array.from(state.addPeopleSelected.keys());
    state.addingPeople = true;

    Api.request({
      url: '/calls/group/' + callId + '/participants',
      method: 'POST',
      data: { user_ids: userIds }
    })
      .done(function (response) {
        closeAddPeopleModal();
        // Same incremental reconciliation every OTHER participant's next
        // poll already does (see handleCallUpdate) — no full rebuild, the
        // newly-invited row(s) just get added as fresh Map entries and a
        // new panel row (task requirement).
        reconcileParticipants(response.call.participants);
        render();
        Ping.showToast(
          userIds.length === 1 ? 'Invitation sent.' : userIds.length + ' invitations sent.',
          'success'
        );
      })
      .fail(function (xhr) {
        Ping.showToast(Ping.getErrorMessage(xhr, 'Unable to add people to this call.'), 'error');
      })
      .always(function () {
        state.addingPeople = false;
      });
  }

  function renderAddPeopleButton() {
    const atCap = remainingAddPeopleSlots() <= 0;
    $addPeopleBtn
      .prop('disabled', atCap)
      .attr('title', atCap ? 'Group calls are limited to ' + GROUP_CALL_MAX_PARTICIPANTS + ' participants' : 'Add People');
  }

  function startGroupCall(conversationId, participantIds) {
    // Guards against a rapid double-confirm starting two concurrent group
    // calls / two getUserMedia acquisitions — isActive() (checked in
    // openStartModal) treats any non-'idle' phase, including this one, as
    // "already busy", same guard calls.js's own startCall uses.
    state.phase = 'starting';
    const myGeneration = state.pollGeneration;

    acquireLocalMedia()
      .then(function (stream) {
        if (state.pollGeneration !== myGeneration) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          return Promise.reject({ superseded: true });
        }
        state.localStream = stream;
        return Api.request({
          url: '/calls/group',
          method: 'POST',
          data: { conversation_id: conversationId, participant_ids: participantIds }
        });
      })
      .then(function (response) {
        if (state.pollGeneration !== myGeneration) return Promise.reject({ superseded: true });
        enterActiveCall(response.call);
      })
      .catch(function (err) {
        if (err && err.superseded) return;
        Ping.showToast(mediaErrorMessage(err), 'error');
        cleanupLocalMedia();
        state.phase = 'idle';
        render();
      });
  }

  // --- Incoming invitation ------------------------------------------------

  function showIncoming(call) {
    state.phase = 'incoming';
    state.callId = call.id;
    state.conversationId = call.conversation_id;
    state.creatorId = call.creator.id;
    state.lastSignalId = 0;
    reconcileParticipants(call.participants, true);

    Avatars.apply($bannerAvatar, call.creator.name, call.creator.avatar_url);
    $bannerCreator.text(call.creator.name);
    render();
    pollCallState(); // don't wait out a full idle-speed tick before this becomes pollable
  }

  function dismissIncoming() {
    state.dismissedCallId = state.callId;
    state.pollGeneration++;
    state.phase = 'idle';
    state.callId = null;
    state.conversationId = null;
    state.creatorId = null;
    state.participants = new Map();
    render();
    scheduleNextPoll();
  }

  function joinIncoming() {
    if (state.phase !== 'incoming' || !state.callId) return;
    if (Calls.isActive()) {
      Ping.showToast('You are already on a call.', 'error');
      return;
    }
    if (!rtcSupported()) {
      Ping.showToast('Your browser does not support group calls.', 'error');
      dismissIncoming();
      return;
    }

    const callId = state.callId;
    const myGeneration = state.pollGeneration;

    acquireLocalMedia()
      .then(function (stream) {
        if (state.pollGeneration !== myGeneration || state.callId !== callId) {
          stream.getTracks().forEach(function (t) { t.stop(); });
          return Promise.reject({ superseded: true });
        }
        state.localStream = stream;
        return Api.request({ url: '/calls/group/' + callId + '/join', method: 'POST' });
      })
      .then(function (response) {
        if (state.pollGeneration !== myGeneration) return Promise.reject({ superseded: true });
        enterActiveCall(response.call);
      })
      .catch(function (err) {
        if (err && err.superseded) return;
        Ping.showToast(mediaErrorMessage(err), 'error');
        cleanupLocalMedia();
        teardownToIdle(); // dismiss the prompt on any failure — same posture as calls.js's own acceptCall
      });
  }

  function enterActiveCall(call) {
    state.callId = call.id;
    state.conversationId = call.conversation_id;
    state.creatorId = call.creator.id;
    state.phase = 'active';
    state.muted = false;
    // Never auto-enabled on join OR resume (task requirement) — mirrors
    // this module's existing choice not to persist state.muted across a
    // refresh either (unlike calls.js's 1:1 calls, which use a localStorage
    // recovery hint for both — see resumeActiveCall's own docstring for why
    // a group call's reconnect story is simpler: nothing here is restored,
    // it's just always off until the user explicitly turns it on again).
    state.cameraOn = false;
    state.startingCamera = false;
    state.dismissedCallId = null;
    // A late joiner needs to know who's already sharing (if anyone) right
    // away — set directly rather than through syncScreenShareState, since
    // there's no "am I already sharing" belief yet to protect at this point.
    state.activeSharerId = call.screen_share ? call.screen_share.user.id : null;
    reconcileParticipants(call.participants);
    startSpeakingDetection();
    render();
    pollCallState();
  }

  /**
   * Reconnects to a group call this side was already 'joined' to before the
   * page reloaded — found by pollForIncoming's own resume check (the server
   * never force-left this participant on refresh; see the module
   * docstring). Deliberately skips the incoming banner entirely: unlike a
   * fresh invitation, there's nothing to ask the user to accept, they were
   * already in this call a moment ago. Mirrors joinIncoming's async chain
   * (acquire mic -> POST .../join -> enterActiveCall), but entered
   * automatically rather than from a click, and re-POSTing .../join is
   * simply idempotent here rather than a first-time join.
   */
  function resumeActiveCall(call) {
    if (state.phase !== 'idle') return; // something else already claimed the phase in the meantime — next idle tick retries
    if (Calls.isActive()) return; // a 1:1 call is somehow already active — next idle tick retries once it ends
    if (!rtcSupported()) return; // silent — this is a background resume, not a user action; the server-side abandonment timeout will eventually reap this participant if they can truly never reconnect

    state.callId = call.id;
    state.conversationId = call.conversation_id;
    state.creatorId = call.creator.id;
    // Not 'active' (nothing to render yet — participants/localStream aren't
    // populated until enterActiveCall) and not 'idle' (would let a 1:1 or a
    // second group call start concurrently via isActive()'s own idle check)
    // — this transitional phase exists purely to close that gap.
    state.phase = 'resuming';
    const myGeneration = state.pollGeneration;

    acquireLocalMedia()
      .then(function (stream) {
        if (state.pollGeneration !== myGeneration || state.phase !== 'resuming') {
          stream.getTracks().forEach(function (t) { t.stop(); });
          return Promise.reject({ superseded: true });
        }
        state.localStream = stream;

        // Our own screen-share claim from before the reload, if any — the
        // actual getDisplayMedia() capture died with the page and must
        // never be silently reacquired without a fresh user gesture (same
        // "only ever from an explicit click" posture startScreenShare
        // already documents). Release the slot; the sharing indicator
        // clears for everyone and this side can click Share Screen again.
        if (call.screen_share && call.screen_share.user.id === state.currentUser.id) {
          Api.request({ url: '/calls/group/' + call.id + '/screen-share/stop', method: 'POST' });
        }

        return Api.request({ url: '/calls/group/' + call.id + '/join', method: 'POST' });
      })
      .then(function (response) {
        if (state.pollGeneration !== myGeneration) return Promise.reject({ superseded: true });
        enterActiveCall(response.call);
      })
      .catch(function (err) {
        if (err && err.superseded) return;
        // Fail soft — never POST .../leave here (the whole point of this
        // feature is that failing to reconnect instantly isn't the same as
        // leaving): just drop back to idle and let the next idle poll try
        // again. If the underlying issue (mic now blocked, etc.) doesn't
        // resolve, services/call_service.apply_group_call_abandonment
        // eventually reaps the now-stale participant row server-side.
        cleanupLocalMedia();
        state.callId = null;
        state.conversationId = null;
        state.creatorId = null;
        state.phase = 'idle';
        render();
        scheduleNextPoll();
      });
  }

  // --- WebRTC mesh ------------------------------------------------------

  function shouldInitiateTo(otherUserId) {
    return state.currentUser.id < otherUserId;
  }

  function ensureAudioEl(userId) {
    let el = document.getElementById('groupCallAudio-' + userId);
    if (!el) {
      el = document.createElement('audio');
      el.id = 'groupCallAudio-' + userId;
      el.autoplay = true;
      $audioContainer.append(el);
    }
    return el;
  }

  function removeAudioEl(userId) {
    const el = document.getElementById('groupCallAudio-' + userId);
    if (el) {
      el.srcObject = null;
      el.remove();
    }
  }

  function setConnectionState(userId, connectionState) {
    const p = state.participants.get(userId);
    if (p) p.connectionState = connectionState;
  }

  function createPeerConnectionFor(userId) {
    const pc = new RTCPeerConnection({ iceServers: state.iceServers || DEFAULT_ICE_SERVERS });
    const peer = {
      pc: pc,
      pendingCandidates: [],
      // Per-peer negotiation state (task requirement: never a global flag)
      // — see negotiateWithPeer/settlePeerNegotiation.
      negotiating: false,
      pendingNegotiation: null,
      pendingAnswerResolve: null,
      pendingAnswerReject: null,
      answerTimeout: null,
      // Set just before setRemoteDescription for an incoming 'offer' that
      // adds a NEW video track (see handleSignal's 'offer' branch and
      // negotiateWithPeer's offerExtras param) — tells the very next
      // ontrack's video-kind branch whether the track it's about to see is
      // a camera or a screen share, since WebRTC's own ontrack event has no
      // such notion built in. Always consumed (reset to null) by that same
      // ontrack — see createPeerConnectionFor.
      pendingIncomingVideoKind: null,
      // This side's OUTGOING screen-share sender on THIS connection, once
      // added (see addScreenTrackToPeer) — independent per peer, task
      // requirement.
      screenSender: null,
      // Whatever this peer is sending US as a screen share, if they're the
      // current sharer — also independent per peer, so one peer's failure
      // never touches another's copy (see module docstring).
      remoteScreenTrack: null,
      remoteScreenStream: null,
      // This side's OUTGOING camera sender on THIS connection, once added
      // (see addCameraTrackToPeer) — same independence reasoning as
      // screenSender above.
      cameraSender: null,
      // Whatever this peer is sending US as their camera, if their camera
      // is currently on — same independence reasoning as remoteScreenTrack
      // above (see the module docstring's camera paragraph).
      remoteCameraTrack: null,
      remoteCameraStream: null
    };
    state.peers.set(userId, peer);
    setConnectionState(userId, 'connecting');

    pc.onicecandidate = function (e) {
      if (e.candidate) sendSignal(userId, 'ice-candidate', { candidate: e.candidate });
    };

    pc.ontrack = function (e) {
      if (e.track.kind === 'video') {
        // See peer.pendingIncomingVideoKind's own docstring above — set by
        // handleSignal's 'offer' branch right before setRemoteDescription,
        // consumed here exactly once. Defaults to 'screen' so an offer sent
        // by a peer running older in-session state (there isn't one in
        // practice — this is a same-deploy signal — but the fallback costs
        // nothing) still lands on the pre-camera-feature behavior rather
        // than silently dropping the track.
        const videoKind = peer.pendingIncomingVideoKind || 'screen';
        peer.pendingIncomingVideoKind = null;

        if (videoKind === 'camera') {
          peer.remoteCameraTrack = e.track;
          peer.remoteCameraStream = e.streams[0];
          e.track.onended = function () {
            const p = state.peers.get(userId);
            if (p && p.remoteCameraTrack === e.track) {
              p.remoteCameraTrack = null;
              p.remoteCameraStream = null;
            }
            renderCameraGrid();
          };
          renderCameraGrid();
          return;
        }

        peer.remoteScreenTrack = e.track;
        peer.remoteScreenStream = e.streams[0];
        // The track can arrive before the broadcast signal/next poll
        // catches up (e.g. right after a fresh renegotiation) — treat its
        // mere arrival as "this peer is the sharer" so the viewer never
        // waits on those when it already has the actual video.
        if (state.activeSharerId == null) state.activeSharerId = userId;
        e.track.onended = function () {
          const p = state.peers.get(userId);
          if (p && p.remoteScreenTrack === e.track) {
            p.remoteScreenTrack = null;
            p.remoteScreenStream = null;
          }
          renderScreenPanel();
        };
        renderScreenPanel();
        renderBar();
        return;
      }
      ensureAudioEl(userId).srcObject = e.streams[0];
    };

    pc.oniceconnectionstatechange = function () {
      const cs = pc.iceConnectionState;
      if (cs === 'connected' || cs === 'completed') {
        setConnectionState(userId, 'connected');
        renderParticipants();
      } else if (cs === 'failed') {
        // Failure isolation (task requirement): only THIS pair is affected.
        // The peer stays listed as "joined" (server-authoritative) with a
        // transient "failed" connection badge; the next poll's
        // reconcileParticipants sees them still joined and not in
        // state.peers anymore, and automatically retries — see the module
        // docstring. If screen sharing was flowing over this one
        // connection (either direction), teardownPeer below cleans that up
        // too, without affecting any other peer's copy.
        setConnectionState(userId, 'failed');
        renderParticipants();
        teardownPeer(userId);
      }
    };

    if (state.localStream) {
      state.localStream.getTracks().forEach(function (track) {
        pc.addTrack(track, state.localStream);
      });
    }

    return peer;
  }

  function connectToParticipant(userId) {
    if (userId === state.currentUser.id || state.peers.has(userId)) return;
    createPeerConnectionFor(userId);
    if (shouldInitiateTo(userId)) {
      negotiateWithPeer(userId, null).catch(function () {
        setConnectionState(userId, 'failed');
        renderParticipants();
        teardownPeer(userId);
      });
    }
  }

  function teardownPeer(userId) {
    const peer = state.peers.get(userId);
    if (!peer) return;
    clearTimeout(peer.answerTimeout);
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.oniceconnectionstatechange = null;
    peer.pc.close();
    state.peers.delete(userId);
    removeAudioEl(userId);
    removeVideoTile(userId); // no-op if this peer never had a camera tile — see renderCameraGrid
    if (state.activeSharerId === userId) {
      // Lost the connection carrying the current sharer's video — clear
      // THIS side's viewer immediately rather than leaving a frozen last
      // frame up; reconcileParticipants' retry (if they're still genuinely
      // in the call) will re-establish it once the peer reconnects, and
      // settlePeerNegotiation re-adds the screen track automatically once
      // the sharer's side finishes that reconnection.
      state.activeSharerId = null;
      renderScreenPanel();
      renderBar();
    }
  }

  function flushPendingCandidates(peer) {
    const candidates = peer.pendingCandidates;
    peer.pendingCandidates = [];
    candidates.forEach(function (candidate) {
      peer.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(function () {});
    });
  }

  /**
   * Runs an offer/answer exchange against peer `userId`'s OWN
   * RTCPeerConnection — used for the peer's very first (base call)
   * negotiation (`prepare` is null) AND, later, adding this side's screen
   * or camera track to it (`prepare` calls pc.addTrack — see
   * addScreenTrackToPeer/addCameraTrackToPeer). Serialized entirely through
   * THIS peer's own `negotiating` flag (task requirement: no global flag) —
   * a second call while one is already in flight is queued as
   * `pendingNegotiation` and retried the moment the first settles (see
   * settlePeerNegotiation), rather than ever starting a second concurrent
   * local negotiation on one RTCPeerConnection, which WebRTC itself would
   * reject. Resolves once the matching answer has been received and
   * applied, or rejects on failure/timeout — callers decide what "this one
   * peer failed" means for them (base call: tear the peer down; screen/
   * camera add: just drop that one sender — see addScreenTrackToPeer/
   * addCameraTrackToPeer).
   *
   * `offerExtras`, when given, is merged into the offer signal's payload
   * alongside `sdp` — used exclusively to carry `videoKind: 'camera' |
   * 'screen'` (see addScreenTrackToPeer/addCameraTrackToPeer) so the
   * RECEIVING side's ontrack can tell the two kinds of video apart; the
   * base call and a queued retry of a call that had none simply omit it.
   */
  function negotiateWithPeer(userId, prepare, offerExtras) {
    const peer = state.peers.get(userId);
    if (!peer) return Promise.resolve();

    if (peer.negotiating) {
      return new Promise(function (resolve, reject) {
        peer.pendingNegotiation = function () {
          negotiateWithPeer(userId, prepare, offerExtras).then(resolve, reject);
        };
      });
    }

    peer.negotiating = true;
    if (prepare) prepare(peer);

    return peer.pc.createOffer()
      .then(function (offer) { return peer.pc.setLocalDescription(offer); })
      .then(function () {
        const offerPayload = Object.assign({ sdp: peer.pc.localDescription }, offerExtras);
        sendSignal(userId, 'offer', offerPayload);
        return new Promise(function (resolve, reject) {
          peer.pendingAnswerResolve = resolve;
          peer.pendingAnswerReject = reject;
          peer.answerTimeout = setTimeout(function () {
            peer.pendingAnswerResolve = null;
            peer.pendingAnswerReject = null;
            reject(new Error('Renegotiation timed out'));
          }, CALL_RENEGOTIATION_TIMEOUT_MS);
        });
      })
      .finally(function () { settlePeerNegotiation(userId); });
  }

  /** Clears peer `userId`'s negotiation lock and either runs whatever got
   * queued behind it, or — if nothing did — opportunistically adds this
   * side's screen and/or camera track to it when this side currently has
   * either active and hasn't added it to THIS peer yet (the late-joiner /
   * reconnect case — see the module docstring). Both checks run
   * independently (never else-if): a peer that connects while this side is
   * BOTH sharing its screen AND has its camera on needs both added, and the
   * per-peer negotiation queue this same function drives already serializes
   * the two additions correctly if both fire here at once (the second call
   * just queues behind the first — see negotiateWithPeer). Called both when
   * an offerer's answer lands (negotiateWithPeer's own .finally) and right
   * after an answerer finishes sending ITS answer (handleSignal's 'offer'
   * branch) — the same hook either way, since either side settling is
   * equally "this peer's base call is now ready for a screen/camera track
   * if one's due". */
  function settlePeerNegotiation(userId) {
    const peer = state.peers.get(userId);
    if (!peer) return;
    peer.negotiating = false;
    if (peer.pendingNegotiation) {
      const next = peer.pendingNegotiation;
      peer.pendingNegotiation = null;
      next();
      return;
    }
    if (state.sharingScreen && !peer.screenSender) {
      addScreenTrackToPeer(userId);
    }
    if (state.cameraOn && !peer.cameraSender) {
      addCameraTrackToPeer(userId);
    }
  }

  /** Adds (or reuses) this side's OWN local screen track as a sender on
   * peer `userId`'s connection — called once per peer when a share starts
   * (looped over every currently-connected peer — see startScreenShare)
   * and again, automatically, whenever a NEW peer connection settles while
   * a share is already in progress (see settlePeerNegotiation). */
  function addScreenTrackToPeer(userId) {
    const peer = state.peers.get(userId);
    if (!peer || !state.localScreenTrack) return;
    if (peer.screenSender) {
      // Already added earlier THIS call (e.g. re-sharing after an earlier
      // stop) — reuse it via replaceTrack, no renegotiation needed, same
      // optimization calls.js's 1:1 startScreenShare already uses.
      peer.screenSender.replaceTrack(state.localScreenTrack).catch(function () {});
      return;
    }
    negotiateWithPeer(userId, function (p) {
      p.screenSender = p.pc.addTrack(state.localScreenTrack, state.localScreenStream);
    }, { videoKind: 'screen' }).catch(function () {
      // This ONE peer's screen renegotiation failed — isolate it (task
      // requirement): drop just this sender, leave the base audio
      // connection to them (and every other peer's screen feed) completely
      // untouched. That peer's viewer simply never gets the screen.
      const p = state.peers.get(userId);
      if (p && p.screenSender) {
        try { p.pc.removeTrack(p.screenSender); } catch (e) { /* connection may already be closed */ }
        p.screenSender = null;
      }
    });
  }

  /** Adds (or reuses) this side's OWN local camera track as a sender on
   * peer `userId`'s connection — same shape as addScreenTrackToPeer above,
   * called once per peer when the camera turns on (looped over every
   * currently-connected peer — see startCamera) and again, automatically,
   * whenever a NEW peer connection settles while the camera is already on
   * (see settlePeerNegotiation). */
  function addCameraTrackToPeer(userId) {
    const peer = state.peers.get(userId);
    if (!peer || !state.localCameraTrack) return;
    if (peer.cameraSender) {
      // Already added earlier THIS call (e.g. turning the camera back on
      // after an earlier stop) — reuse it via replaceTrack, no
      // renegotiation needed, same optimization addScreenTrackToPeer uses.
      peer.cameraSender.replaceTrack(state.localCameraTrack).catch(function () {});
      return;
    }
    negotiateWithPeer(userId, function (p) {
      p.cameraSender = p.pc.addTrack(state.localCameraTrack, state.localCameraStream);
    }, { videoKind: 'camera' }).catch(function () {
      // This ONE peer's camera renegotiation failed — isolate it (task
      // requirement): drop just this sender, leave the base audio
      // connection to them (and every other peer's camera/screen feed)
      // completely untouched. That peer's tile simply never gets our video.
      const p = state.peers.get(userId);
      if (p && p.cameraSender) {
        try { p.pc.removeTrack(p.cameraSender); } catch (e) { /* connection may already be closed */ }
        p.cameraSender = null;
      }
    });
  }

  function handleSignal(fromUserId, signal) {
    if (signal.message_type === 'mute-state') {
      const p = state.participants.get(fromUserId);
      if (p) p.muted = !!signal.payload.muted;
      renderParticipants();
      return;
    }

    if (signal.message_type === 'camera-state') {
      // The ONLY "is this participant's camera on" fact this module has —
      // see the module docstring's camera paragraph for why track liveness
      // alone can't serve that role. Reconciled on top of whatever WebRTC
      // track this peer has already sent us (renderCameraGrid checks both:
      // this flag for show/hide, the track's readyState for "show the real
      // video vs. a connecting placeholder").
      const p = state.participants.get(fromUserId);
      if (p) p.cameraOn = !!signal.payload.enabled;
      renderCameraGrid();
      renderParticipants(); // panel row's "Camera on" status text — see renderParticipants
      return;
    }

    if (signal.message_type === 'screen-share-state') {
      // Not itself authoritative (see the module docstring) — just a
      // snappier nudge than waiting out a poll tick; syncScreenShareState
      // reconciles against the server truth every poll regardless.
      if (signal.payload.enabled) {
        state.activeSharerId = fromUserId;
      } else if (state.activeSharerId === fromUserId) {
        state.activeSharerId = null;
      }
      renderScreenPanel();
      renderBar();
      return;
    }

    let peer = state.peers.get(fromUserId);

    if (signal.message_type === 'offer') {
      if (!peer) peer = createPeerConnectionFor(fromUserId);
      // Guards against a locally-initiated negotiateWithPeer (e.g. a
      // queued screen/camera-add) starting a second, competing offer to
      // this SAME peer while we're mid-answer — see negotiateWithPeer's own
      // queueing.
      peer.negotiating = true;
      // See peer.pendingIncomingVideoKind's own docstring (createPeerConnectionFor)
      // — must be set BEFORE setRemoteDescription, since that call is what
      // synchronously fires ontrack for a newly-added video track.
      peer.pendingIncomingVideoKind = signal.payload.videoKind || null;
      peer.pc.setRemoteDescription(new RTCSessionDescription(signal.payload.sdp))
        .then(function () { return flushPendingCandidates(peer); })
        .then(function () { return peer.pc.createAnswer(); })
        .then(function (answer) { return peer.pc.setLocalDescription(answer); })
        .then(function () { sendSignal(fromUserId, 'answer', { sdp: peer.pc.localDescription }); })
        .catch(function () {
          setConnectionState(fromUserId, 'failed');
          renderParticipants();
          teardownPeer(fromUserId);
        })
        .finally(function () { settlePeerNegotiation(fromUserId); });
      return;
    }

    if (signal.message_type === 'answer') {
      if (!peer) return; // stale — this side's own connection to them is already gone
      const resolve = peer.pendingAnswerResolve;
      const reject = peer.pendingAnswerReject;
      clearTimeout(peer.answerTimeout);
      peer.pendingAnswerResolve = null;
      peer.pendingAnswerReject = null;
      peer.pc.setRemoteDescription(new RTCSessionDescription(signal.payload.sdp))
        .then(function () { return flushPendingCandidates(peer); })
        .then(function () { if (resolve) resolve(); })
        .catch(function (err) {
          if (reject) {
            reject(err);
          } else {
            setConnectionState(fromUserId, 'failed');
            renderParticipants();
            teardownPeer(fromUserId);
          }
        });
      return;
    }

    if (signal.message_type === 'ice-candidate') {
      if (!peer) return;
      if (peer.pc.remoteDescription && peer.pc.remoteDescription.type) {
        peer.pc.addIceCandidate(new RTCIceCandidate(signal.payload.candidate)).catch(function () {});
      } else {
        peer.pendingCandidates.push(signal.payload.candidate);
      }
    }
  }

  function sendSignal(peerUserId, messageType, payload) {
    if (!state.callId) return;
    Api.request({
      url: '/calls/group/' + state.callId + '/signals',
      method: 'POST',
      data: { peer_user_id: peerUserId, message_type: messageType, payload: payload }
    });
  }

  /**
   * Rebuilds state.participants from the server's authoritative roster
   * (every poll response carries the full current list — see
   * GroupCallOut.participants) and reacts to what changed: a newcomer who's
   * now "joined" gets connectToParticipant'd (both by everyone already in
   * the call AND by the newcomer themselves, for everyone ELSE already
   * joined — see the module docstring's offer/answer rule for why that
   * never double-connects), and anyone who moved to "left" has their peer
   * connection and list entry removed outright (task requirement — no
   * lingering entry).
   *
   * `passive` is true while merely showing the incoming banner (not yet
   * joined) — the list is populated for the eventual participant panel, but
   * no peer connections are opened until this side actually joins.
   */
  function reconcileParticipants(serverParticipants, passive) {
    const seenIds = new Set();

    serverParticipants.forEach(function (p) {
      seenIds.add(p.user.id);
      if (p.status === 'left') {
        state.participants.delete(p.user.id);
        teardownPeer(p.user.id);
        return;
      }
      const existing = state.participants.get(p.user.id);
      state.participants.set(p.user.id, {
        user: p.user,
        status: p.status,
        muted: existing ? existing.muted : false,
        // Reconciled purely from the broadcast 'camera-state' signal (see
        // handleSignal) — never from this server list, which has no notion
        // of camera state at all (see the module docstring). Defaults false
        // same as muted: a freshly-seen participant is assumed camera-off
        // until their own signal (replayed on a late joiner's first poll,
        // same as mute-state) says otherwise.
        cameraOn: existing ? existing.cameraOn : false,
        connectionState: p.user.id === state.currentUser.id ? 'connected' : (existing ? existing.connectionState : null)
      });

      if (!passive && state.phase === 'active' && p.status === 'joined' && p.user.id !== state.currentUser.id) {
        connectToParticipant(p.user.id);
      }
    });

    // Belt-and-suspenders: drop any locally-held participant the server no
    // longer lists at all (shouldn't normally happen — the roster is fixed
    // at creation time — but never leave a stale entry/peer around if it
    // does).
    Array.from(state.participants.keys()).forEach(function (userId) {
      if (!seenIds.has(userId)) {
        state.participants.delete(userId);
        teardownPeer(userId);
      }
    });
  }

  // --- Mute ---------------------------------------------------------------

  function toggleMute() {
    if (!state.localStream) return;
    state.muted = !state.muted;
    state.localStream.getAudioTracks().forEach(function (track) {
      track.enabled = !state.muted;
    });
    sendSignal(null, 'mute-state', { muted: state.muted }); // broadcast — see models.CallSignal's peer_user_id docstring
    render();
  }

  // --- Screen sharing (see module docstring) -------------------------------

  function screenShareSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
  }

  function toggleScreenShare() {
    if (state.sharingScreen) {
      stopScreenShare(false);
    } else {
      startScreenShare();
    }
  }

  /** Only reachable while actually in the call and nobody else already
   * holds the slot — see renderScreenShareButton's disabled state, which
   * mirrors this same check for the UI. The REST claim happens BEFORE
   * getDisplayMedia is even requested, so a losing race (someone else grabs
   * the slot a moment earlier) never bothers the user with a screen-picker
   * dialog for nothing. */
  function startScreenShare() {
    if (state.phase !== 'active' || !state.callId) return;
    if (state.sharingScreen || state.startingScreenShare) return;
    if (state.activeSharerId != null && state.activeSharerId !== state.currentUser.id) return;
    if (!screenShareSupported()) {
      Ping.showToast('Screen sharing is not supported in this browser.', 'error');
      return;
    }

    state.startingScreenShare = true;
    renderBar();
    const myGeneration = state.pollGeneration;
    const callId = state.callId;

    Api.request({ url: '/calls/group/' + callId + '/screen-share/start', method: 'POST' })
      .then(function () {
        if (state.pollGeneration !== myGeneration) return Promise.reject({ superseded: true });

        return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
          .catch(function (mediaErr) {
            // We already hold the server-side slot — release it before
            // surfacing the error, so a cancelled picker never leaves
            // everyone else locked out waiting for a share that's never
            // coming.
            Api.request({ url: '/calls/group/' + callId + '/screen-share/stop', method: 'POST' });
            throw mediaErr;
          });
      })
      .then(function (stream) {
        if (state.pollGeneration !== myGeneration || state.phase !== 'active') {
          stream.getTracks().forEach(function (t) { t.stop(); });
          Api.request({ url: '/calls/group/' + callId + '/screen-share/stop', method: 'POST' });
          return Promise.reject({ superseded: true });
        }

        state.localScreenStream = stream;
        state.localScreenTrack = stream.getVideoTracks()[0];
        // The task's mandatory case: the user picks "Stop sharing" from the
        // BROWSER's own native screen-share indicator/UI rather than PING's
        // button — this is the only way that's ever surfaced to the page.
        state.localScreenTrack.onended = function () {
          if (state.sharingScreen) stopScreenShare(true);
        };
        state.sharingScreen = true;
        state.startingScreenShare = false;
        state.activeSharerId = state.currentUser.id;
        render();

        // Add to every peer already connected; any peer that connects
        // LATER while still sharing picks it up automatically via
        // settlePeerNegotiation once its own base negotiation settles.
        Array.from(state.peers.keys()).forEach(function (userId) { addScreenTrackToPeer(userId); });
        sendSignal(null, 'screen-share-state', { enabled: true });
      })
      .catch(function (err) {
        state.startingScreenShare = false;
        if (err && err.superseded) { render(); return; }
        handleScreenShareError(err);
        render();
      });
  }

  /**
   * @param fromBrowser true when this is the browser's own native "Stop
   *   sharing" control firing localScreenTrack.onended, rather than PING's
   *   own button — task requirement: both must land in exactly the same
   *   state.
   */
  function stopScreenShare(fromBrowser) {
    if (!state.sharingScreen && !state.localScreenStream) return;
    const callId = state.callId;
    stopLocalScreenShareTracks();
    state.activeSharerId = null;

    if (callId) Api.request({ url: '/calls/group/' + callId + '/screen-share/stop', method: 'POST' });
    sendSignal(null, 'screen-share-state', { enabled: false }); // broadcast — see models.CallSignal's peer_user_id docstring

    render();
    if (fromBrowser) Ping.showToast('Screen sharing stopped', 'success');
  }

  /** Stops and releases this side's own outgoing screen capture, and clears
   * every peer's sender via replaceTrack(null) — no renegotiation needed to
   * stop (task allows "remove or replace"; this always replaces, mirroring
   * calls.js's 1:1 stopScreenShare so a later re-share this same call can
   * reuse the same senders). Deliberately does NOT touch state.peers'
   * membership or state.activeSharerId itself — callers (stopScreenShare,
   * syncScreenShareState) decide what those should become. */
  function stopLocalScreenShareTracks() {
    if (state.localScreenTrack) {
      state.localScreenTrack.onended = null;
      state.localScreenTrack.stop();
    }
    if (state.localScreenStream) {
      state.localScreenStream.getTracks().forEach(function (t) { t.stop(); }); // releases the OS-level screen-capture indicator
    }
    state.localScreenStream = null;
    state.localScreenTrack = null;
    state.sharingScreen = false;
    state.peers.forEach(function (peer) {
      if (peer.screenSender) peer.screenSender.replaceTrack(null).catch(function () {});
    });
  }

  function handleScreenShareError(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'AbortError') {
      // The user dismissed/cancelled the browser's own screen-picker dialog
      // — not a failure, and explicitly NOT a call failure — the group call
      // just continues exactly as it was.
      Ping.showToast('Screen sharing cancelled', 'error');
      return;
    }
    if (name === 'NotFoundError') {
      Ping.showToast('No screen or window is available to share.', 'error');
      return;
    }
    if (name === 'NotReadableError') {
      Ping.showToast('Your screen could not be captured — it may be blocked by another application.', 'error');
      return;
    }
    if (name === 'OverconstrainedError') {
      Ping.showToast('Screen sharing is not supported with the requested settings.', 'error');
      return;
    }
    if (err && err.responseJSON && err.responseJSON.message) {
      // The REST claim's own failure — e.g. the 409 "someone else is
      // already sharing" a losing race hit (see startScreenShare).
      Ping.showToast(err.responseJSON.message, 'error');
      return;
    }
    Ping.showToast('Unable to start screen sharing.', 'error');
  }

  /** Reconciles state.activeSharerId against the server-authoritative
   * GroupCallOut.screen_share carried on every poll — the fallback for
   * whatever the (best-effort, unordered) 'screen-share-state' broadcast
   * signal missed: a late joiner who wasn't there for the original
   * broadcast, a dropped signal, or simply the very first tick after
   * joining. Deliberately never overrides THIS side's own belief about
   * whether IT is sharing (state.sharingScreen, driven only by explicit
   * user action / the browser's native stop control) — a stale server read
   * naming US as the sharer right after our own stop request hasn't been
   * processed yet should never make the UI flicker back to "sharing". */
  function syncScreenShareState(screenShare) {
    const serverSharerId = screenShare ? screenShare.user.id : null;
    if (state.sharingScreen || serverSharerId === state.currentUser.id) return;
    if (serverSharerId === state.activeSharerId) return;
    state.activeSharerId = serverSharerId;
    renderScreenPanel();
    renderBar();
  }

  // --- Camera (see module docstring) ---------------------------------------
  // Entirely independent of mute above and of screen sharing below — a
  // separate track, a separate flag, a separate button (same "never
  // coupled" requirement calls.js's 1:1 toggleCamera already follows for
  // mic vs. camera). Unlike screen sharing, there is no server-side slot to
  // claim first: any number of participants may have a camera on at once,
  // so starting one is purely a local getUserMedia call plus a broadcast
  // signal, never a REST claim that could 409.

  function cameraSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function toggleCamera() {
    if (state.cameraOn) {
      stopCamera(false);
    } else {
      startCamera();
    }
  }

  /** Only reachable while actually in the call and not already on/starting
   * — see renderCameraButton's disabled state, which mirrors this same
   * check for the UI. Camera permission is requested HERE, at the moment
   * the user explicitly clicks the button — never at join time (task
   * requirement: joining a group call must never touch the camera). */
  function startCamera() {
    if (state.phase !== 'active' || !state.callId) return;
    if (state.cameraOn || state.startingCamera) return;
    if (!cameraSupported()) {
      Ping.showToast('Your browser does not support camera video.', 'error');
      return;
    }

    state.startingCamera = true;
    renderBar();
    const myGeneration = state.pollGeneration;

    navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      .then(function (stream) {
        if (state.pollGeneration !== myGeneration || state.phase !== 'active') {
          stream.getTracks().forEach(function (t) { t.stop(); });
          return Promise.reject({ superseded: true });
        }

        state.localCameraStream = stream;
        state.localCameraTrack = stream.getVideoTracks()[0];
        // The task's mandatory case: the camera is stopped by the OS/browser
        // itself (device unplugged, revoked permission, another app taking
        // exclusive access) rather than PING's own button — mirrors
        // startScreenShare's identical handling of the browser's native
        // "Stop sharing" control.
        state.localCameraTrack.onended = function () {
          if (state.cameraOn) stopCamera(true);
        };
        state.cameraOn = true;
        state.startingCamera = false;
        render(); // show the local camera tile (task requirement) the instant it's available

        // Add to every peer already connected; any peer that connects LATER
        // while the camera is still on picks it up automatically via
        // settlePeerNegotiation once its own base negotiation settles —
        // same "late joiner receives active feeds" mechanism screen sharing
        // already established.
        Array.from(state.peers.keys()).forEach(function (userId) { addCameraTrackToPeer(userId); });
        sendSignal(null, 'camera-state', { enabled: true }); // broadcast — see models.CallSignal's peer_user_id docstring
      })
      .catch(function (err) {
        state.startingCamera = false;
        if (err && err.superseded) { render(); return; }
        // Never terminates the call (task requirement) — just a toast; the
        // participant stays fully in the audio call exactly as before.
        Ping.showToast(cameraErrorMessage(err), 'error');
        render();
      });
  }

  /**
   * @param fromBrowser true when this is the browser/OS stopping the camera
   *   itself (localCameraTrack.onended firing), rather than PING's own
   *   button — task requirement: both must land in exactly the same state.
   */
  function stopCamera(fromBrowser) {
    if (!state.cameraOn && !state.localCameraStream) return;
    stopLocalCameraTracks();
    sendSignal(null, 'camera-state', { enabled: false }); // broadcast — see models.CallSignal's peer_user_id docstring
    render();
    if (fromBrowser) Ping.showToast('Camera stopped', 'error');
  }

  /** Stops and releases this side's own outgoing camera capture (releasing
   * the hardware — task requirement), and clears every peer's sender via
   * replaceTrack(null) — no renegotiation needed to stop (task allows
   * "remove or replace"; this always replaces, mirroring
   * stopLocalScreenShareTracks so turning the camera back on later this
   * same call can reuse the same senders). Deliberately does NOT touch
   * state.peers' membership — callers (stopCamera, teardownToIdle) decide
   * what happens next; teardownToIdle calls this directly (skipping
   * stopCamera's broadcast signal) for the same "the call is ending, no
   * point telling anyone" reason it already skips stopScreenShare's REST
   * call. */
  function stopLocalCameraTracks() {
    if (state.localCameraTrack) {
      state.localCameraTrack.onended = null;
      state.localCameraTrack.stop();
    }
    if (state.localCameraStream) {
      state.localCameraStream.getTracks().forEach(function (t) { t.stop(); }); // releases the OS-level camera indicator
    }
    state.localCameraStream = null;
    state.localCameraTrack = null;
    state.cameraOn = false;
    state.peers.forEach(function (peer) {
      if (peer.cameraSender) peer.cameraSender.replaceTrack(null).catch(function () {});
    });
  }

  function cameraErrorMessage(err) {
    const name = err && err.name;
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return 'Camera permission is required to turn on your camera.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No camera was found on this device.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Your camera could not be accessed — it may be in use by another application.';
    }
    if (name === 'OverconstrainedError') {
      return 'Camera is not supported with the requested settings.';
    }
    return 'Unable to turn on your camera.';
  }

  // --- Screen viewer expand/collapse (UI-only) -----------------------------
  // Mirrors calls.js's own toggleScreenViewerExpanded/collapseScreenViewer —
  // pure local view-size state, never signaled/persisted, so each
  // participant's browser expands/collapses completely independently of
  // every other's (task requirement).

  function toggleScreenViewerExpanded() {
    if (state.activeSharerId == null) return;
    state.screenViewerExpanded = !state.screenViewerExpanded;
    renderScreenPanel();
  }

  function collapseScreenViewer() {
    if (!state.screenViewerExpanded) return;
    state.screenViewerExpanded = false;
    renderScreenPanel();
  }

  // --- Speaking detection (local only) -------------------------------------
  // Remote speaking detection would need one extra AnalyserNode PER peer
  // stream, continuously polled — real audio-processing/CPU cost that scales
  // with participant count, for a purely cosmetic indicator. The task
  // explicitly allows skipping it with a documented limitation in that case
  // (see calls.js's own docstring conventions for how this codebase
  // documents scope decisions) — remote participants show connection +
  // mute status only, never a speaking indicator. Local speaking uses ONE
  // AudioContext + one AnalyserNode, torn down with the call.

  function startSpeakingDetection() {
    if (!state.localStream) return;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) return;
    try {
      state.audioContext = new AudioContextCtor();
      const source = state.audioContext.createMediaStreamSource(state.localStream);
      state.analyser = state.audioContext.createAnalyser();
      state.analyser.fftSize = 512;
      source.connect(state.analyser);
      state.analyserData = new Uint8Array(state.analyser.frequencyBinCount);
      tickSpeaking();
    } catch (e) {
      // Never let speaking detection block/break the actual call.
      state.audioContext = null;
      state.analyser = null;
    }
  }

  function tickSpeaking() {
    if (!state.analyser) return;
    state.analyser.getByteFrequencyData(state.analyserData);
    let sum = 0;
    for (let i = 0; i < state.analyserData.length; i++) sum += state.analyserData[i];
    const avg = sum / state.analyserData.length;
    const speaking = !state.muted && avg > SPEAKING_THRESHOLD;
    if (speaking !== state.localSpeaking) {
      state.localSpeaking = speaking;
      renderParticipants();
    }
    state.speakingRaf = requestAnimationFrame(tickSpeaking);
  }

  function stopSpeakingDetection() {
    if (state.speakingRaf) cancelAnimationFrame(state.speakingRaf);
    state.speakingRaf = null;
    if (state.audioContext) {
      state.audioContext.close().catch(function () {});
    }
    state.audioContext = null;
    state.analyser = null;
    state.analyserData = null;
    state.localSpeaking = false;
  }

  // --- Panel toggle -------------------------------------------------------

  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    renderPanelVisibility();
  }

  // --- Leave / End --------------------------------------------------------

  function leaveCall() {
    if (state.phase !== 'active' || !state.callId) return;
    Api.request({ url: '/calls/group/' + state.callId + '/leave', method: 'POST' });
    teardownToIdle(); // silent for whoever clicked it — remaining participants learn via their own poll
  }

  function endCallForEveryone() {
    if (state.phase !== 'active' || !state.callId || state.creatorId !== state.currentUser.id) return;
    Api.request({ url: '/calls/group/' + state.callId + '/end', method: 'POST' });
    teardownToIdle();
  }

  // --- Teardown -------------------------------------------------------

  function cleanupLocalMedia() {
    if (state.localStream) {
      state.localStream.getTracks().forEach(function (t) { t.stop(); });
      state.localStream = null;
    }
  }

  function teardownToIdle(message) {
    Array.from(state.peers.keys()).forEach(teardownPeer);
    cleanupLocalMedia();
    stopLocalScreenShareTracks();
    stopLocalCameraTracks();
    stopSpeakingDetection();
    if (!$addPeopleModalOverlay.prop('hidden')) closeAddPeopleModal(); // e.g. the call ended while this side had it open

    state.pollGeneration++;
    state.phase = 'idle';
    state.callId = null;
    state.conversationId = null;
    state.creatorId = null;
    state.participants = new Map();
    state.muted = false;
    state.panelOpen = false;
    state.lastSignalId = 0;
    state.activeSharerId = null;
    state.startingScreenShare = false;
    state.screenViewerExpanded = false;
    state.startingCamera = false;

    render();
    scheduleNextPoll();

    if (message) Ping.showToast(message, 'error');
  }

  // Deliberately NO pagehide/beforeunload/visibilitychange handler here —
  // there used to be one that POSTed .../leave on pagehide, but a page
  // refresh fires that exact same event, with no way to tell it apart from
  // a real tab close at the browser-event level (see the module docstring).
  // So unload is no longer treated as an intentional leave at all: a
  // refreshed participant's row simply stays 'joined' server-side and this
  // side reconnects automatically on reload (see resumeActiveCall). A
  // genuinely abandoned tab (really closed, never reopened) is instead
  // caught lazily by services/call_service.apply_group_call_abandonment
  // once this participant's last_activity_at goes stale — see
  // models.CallParticipant's docstring. Explicit Leave (leaveCall) and End
  // Call (endCallForEveryone) remain the only ways to intentionally end
  // this side's participation.

  function stopPolling() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  // --- Rendering ------------------------------------------------------

  function render() {
    renderBanner();
    renderBar();
    renderPanelVisibility();
    renderParticipants();
    renderScreenPanel();
    renderCameraGrid();
  }

  function renderBanner() {
    $banner.prop('hidden', state.phase !== 'incoming');
  }

  function renderBar() {
    const show = state.phase === 'active';
    $appShell.toggleClass('app-shell--group-call-bar', show);
    $bar.prop('hidden', !show);
    if (!show) return;

    const activeCount = Array.from(state.participants.values()).filter(function (p) { return p.status === 'joined'; }).length;
    $barCount.text(activeCount + (activeCount === 1 ? ' participant' : ' participants'));

    $muteBtn
      .toggleClass('is-active', state.muted)
      .attr('aria-label', state.muted ? 'Unmute microphone' : 'Mute microphone')
      .attr('title', state.muted ? 'Unmute' : 'Mute')
      .find('i').attr('data-lucide', state.muted ? 'mic-off' : 'mic');

    $endBtn.prop('hidden', state.creatorId !== state.currentUser.id);

    renderCameraButton();
    renderScreenShareButton();
    renderSharingIndicator();
    renderAddPeopleButton();

    Ping.renderIcons($bar[0]);
  }

  /** Mirrors renderCameraButton in calls.js — is-active shows the OFF state
   * (mic's own is-active convention above is inverted the same way: it
   * marks MUTED, not "microphone active"), disabled only while a start is
   * already in flight (never for the "on" state itself — clicking it again
   * is how the user turns the camera back off). */
  function renderCameraButton() {
    $cameraBtn
      .prop('disabled', state.startingCamera)
      .toggleClass('is-active', !state.cameraOn)
      .attr('aria-label', state.cameraOn ? 'Turn off camera' : 'Turn on camera')
      .attr('title', state.cameraOn ? 'Turn off camera' : 'Turn on camera')
      .find('i').attr('data-lucide', state.cameraOn ? 'video' : 'video-off');
  }

  function renderScreenShareButton() {
    if (!screenShareSupported()) {
      $screenShareBtn.prop('hidden', true);
      return;
    }
    $screenShareBtn.prop('hidden', false);
    // Disabled while starting (guards a double-click) or while someone ELSE
    // already holds the slot — task requirement. Never disabled for the
    // current sharer themselves; clicking again is how they stop.
    const disabled = state.startingScreenShare ||
      (state.activeSharerId != null && state.activeSharerId !== state.currentUser.id);
    $screenShareBtn
      .prop('disabled', disabled)
      .toggleClass('is-active', state.sharingScreen)
      .attr('aria-label', state.sharingScreen ? 'Stop sharing your screen' : 'Share your screen')
      .attr('title', state.sharingScreen ? 'Stop Sharing' : 'Share Screen')
      .find('i')
      .attr('data-lucide', state.sharingScreen ? 'screen-share-off' : 'screen-share');
  }

  function renderSharingIndicator() {
    const sharerId = state.activeSharerId;
    if (sharerId == null) {
      $sharingIndicator.prop('hidden', true);
      return;
    }
    const isMe = sharerId === state.currentUser.id;
    const participant = state.participants.get(sharerId);
    const name = isMe ? 'You' : (participant ? participant.user.name : 'Someone');
    $sharingIndicatorText.text(isMe ? 'You are sharing your screen' : name + ' is sharing their screen');
    $sharingIndicator.prop('hidden', false);
  }

  function renderScreenExpandButton(expanded) {
    $screenExpandBtn
      .attr('aria-label', expanded ? 'Collapse screen' : 'Expand screen')
      .attr('title', expanded ? 'Collapse screen' : 'Expand screen')
      .find('i')
      .attr('data-lucide', expanded ? 'minimize-2' : 'maximize-2');
    Ping.renderIcons($screenExpandBtn[0]);
  }

  /** The remote screen-share viewer — mirrors calls.js's renderVideoPanel
   * for the screen-share case, minus the local PIP (a group call never
   * shows this side's own outgoing preview here — see the markup's
   * comment). Single idempotent entry point: safe to call from anywhere
   * state.activeSharerId or the sharer's track availability changes
   * (ontrack, a signal, a poll, expand/collapse, teardown). */
  function renderScreenPanel() {
    const sharerId = state.activeSharerId;
    const show = state.phase === 'active' && sharerId != null;
    $screenPanel.prop('hidden', !show);
    // Lets .group-call-video-grid's narrow-screen CSS shift itself below
    // the screen-share panel instead of overlapping it — both are
    // independent position:fixed floating panels (see the module docstring:
    // deliberately never the same element as the screen viewer) that only
    // have room to sit side-by-side at desktop widths — see main.css's
    // body.group-call-screen-sharing rule.
    document.body.classList.toggle('group-call-screen-sharing', show);

    if (!show) {
      if (state.screenViewerExpanded) {
        state.screenViewerExpanded = false;
        document.body.classList.remove('call-screen-expanded-lock');
      }
      $screenPanel.removeClass('call-video-panel--expanded');
      if ($screenVideo[0].srcObject) $screenVideo[0].srcObject = null;
      return;
    }

    const expanded = state.screenViewerExpanded;
    $screenPanel.toggleClass('call-video-panel--expanded', expanded);
    document.body.classList.toggle('call-screen-expanded-lock', expanded);
    renderScreenExpandButton(expanded);

    const peer = state.peers.get(sharerId);
    const trackLive = !!(peer && peer.remoteScreenTrack && peer.remoteScreenTrack.readyState === 'live');
    // sharerId can be the CURRENT USER (this side is the one sharing) —
    // there's no peer entry for yourself, and no local preview to show
    // here (see the markup's comment), so the video element just stays
    // empty in that case; the bar's sharing indicator/badge already covers
    // "you are sharing".
    if (trackLive) {
      const stream = peer.remoteScreenStream;
      if ($screenVideo[0].srcObject !== stream) $screenVideo[0].srcObject = stream;
    } else if ($screenVideo[0].srcObject) {
      $screenVideo[0].srcObject = null;
    }
  }

  // --- Camera video grid (see module docstring) ----------------------------
  // A separate floating panel from the screen-share viewer above — never the
  // same element, never overlapping in meaning: this one is ALWAYS faces
  // (this side's own camera plus every remote participant who currently has
  // theirs on), the other is ALWAYS the one active screen share, and both
  // can be visible at once (task requirement).

  /** Every {userId, user, isMe} entry that should currently have a tile —
   * the single source of truth renderCameraGrid reconciles the DOM against.
   * Self is included via state.cameraOn directly (mirrors how renderBar
   * reads state.muted directly rather than a self-entry in
   * state.participants); every other tile-worthy participant is read off
   * that same map's cameraOn flag (see reconcileParticipants/handleSignal's
   * 'camera-state' branch — the ONLY source for that flag, since the server
   * has no notion of camera state at all). */
  function cameraGridEntries() {
    const entries = [];
    if (state.cameraOn) {
      entries.push({ userId: state.currentUser.id, user: state.currentUser, isMe: true });
    }
    state.participants.forEach(function (p, userId) {
      if (userId === state.currentUser.id) return;
      if (p.status === 'joined' && p.cameraOn) {
        entries.push({ userId: userId, user: p.user, isMe: false });
      }
    });
    return entries;
  }

  /** Gets-or-creates the tile for `userId` — same stable-id-keyed reuse
   * pattern ensureAudioEl already established for the audio mesh, so a tile
   * already showing live video is never torn down and recreated by a later
   * render() call (task requirement: no flicker, no duplicate elements). */
  function ensureVideoTile(userId, user, isMe) {
    let el = document.getElementById('groupCallVideoTile-' + userId);
    if (el) return el;

    el = document.createElement('div');
    el.id = 'groupCallVideoTile-' + userId;
    el.className = 'group-call-video-tile' + (isMe ? ' group-call-video-tile--self' : '');
    el.setAttribute('data-user-id', String(userId));

    const video = document.createElement('video');
    video.className = 'group-call-video-tile__video';
    video.autoplay = true;
    video.playsInline = true;
    video.muted = true; // audio always flows through the separate <audio> mesh (ensureAudioEl) — never duplicated here

    const placeholder = document.createElement('div');
    placeholder.className = 'group-call-video-tile__placeholder';
    const avatarSpan = document.createElement('span');
    avatarSpan.className = 'avatar avatar--md';
    placeholder.appendChild(avatarSpan);

    const label = document.createElement('span');
    label.className = 'group-call-video-tile__name';

    el.appendChild(video);
    el.appendChild(placeholder);
    el.appendChild(label);
    $videoGrid.append(el);

    Avatars.apply($(avatarSpan), user.name, user.avatar_url);
    return el;
  }

  /** Tears down and removes one tile — releasing its <video>'s srcObject
   * FIRST (task requirement: no video continuing to play/decode after a
   * participant leaves or turns their camera off) before detaching it from
   * the DOM. A safe no-op if `userId` never had a tile. */
  function removeVideoTile(userId) {
    const el = document.getElementById('groupCallVideoTile-' + userId);
    if (!el) return;
    const video = el.querySelector('video');
    if (video) video.srcObject = null;
    el.remove();
  }

  /** Single idempotent entry point (same posture as renderScreenPanel) —
   * safe to call from anywhere a participant's cameraOn flag, a peer's
   * remote camera track, or the call's own phase changes (a signal, a
   * poll, ontrack, teardown). Reconciles the grid's actual DOM children
   * against cameraGridEntries() by stable user id rather than ever
   * emptying/rebuilding the container, so an already-playing tile is never
   * flickered or duplicated (task requirement). */
  function renderCameraGrid() {
    if (state.phase !== 'active') {
      // Full reset — the call itself is ending/not yet active, nothing to
      // reconcile incrementally. Clear every srcObject first for the same
      // "no lingering playback" reason removeVideoTile does.
      Array.from($videoGrid[0].children).forEach(function (el) {
        const video = el.querySelector('video');
        if (video) video.srcObject = null;
      });
      $videoGrid.empty().prop('hidden', true);
      return;
    }

    const entries = cameraGridEntries();
    const wantedIds = new Set(entries.map(function (e) { return e.userId; }));

    Array.from($videoGrid[0].children).forEach(function (el) {
      const id = Number(el.getAttribute('data-user-id'));
      if (!wantedIds.has(id)) removeVideoTile(id);
    });

    entries.forEach(function (entry) {
      const el = ensureVideoTile(entry.userId, entry.user, entry.isMe);
      el.querySelector('.group-call-video-tile__name').textContent = entry.isMe ? entry.user.name + ' (You)' : entry.user.name;

      let stream = null;
      let live = false;
      if (entry.isMe) {
        stream = state.localCameraStream;
        live = !!stream;
      } else {
        const peer = state.peers.get(entry.userId);
        // Track liveness here is ONLY "do we have a video element to show
        // at all yet" (still renegotiating vs. already arrived) — never
        // "is the camera currently on" (see the module docstring: a
        // replaceTrack(null)'d remote track stays readyState 'live'
        // forever). That's why entries are filtered by cameraOn ABOVE
        // (cameraGridEntries), not here.
        live = !!(peer && peer.remoteCameraTrack && peer.remoteCameraTrack.readyState === 'live');
        stream = live ? peer.remoteCameraStream : null;
      }

      const video = el.querySelector('video');
      if (live) {
        if (video.srcObject !== stream) video.srcObject = stream;
        el.classList.remove('group-call-video-tile--connecting');
      } else {
        if (video.srcObject) video.srcObject = null;
        el.classList.add('group-call-video-tile--connecting');
      }
    });

    $videoGrid.prop('hidden', entries.length === 0);
  }

  function renderPanelVisibility() {
    $panel.prop('hidden', !(state.phase === 'active' && state.panelOpen));
  }

  const STATUS_LABEL = { invited: 'Invited', joined: 'Connected' };
  const CONNECTION_LABEL = { connecting: 'Connecting…', failed: 'Connection failed' };

  function renderParticipants() {
    if (state.phase === 'idle') {
      $panelList.empty();
      return;
    }

    $panelList.empty();
    const entries = Array.from(state.participants.values());
    entries.sort(function (a, b) {
      if (a.user.id === state.currentUser.id) return -1;
      if (b.user.id === state.currentUser.id) return 1;
      return a.user.name.localeCompare(b.user.name);
    });

    entries.forEach(function (p) {
      const isMe = p.user.id === state.currentUser.id;
      const $row = $('<div>', { class: 'group-call-participant' });
      const $avatar = $('<span>', { class: 'avatar avatar--sm' });
      Avatars.apply($avatar, p.user.name, p.user.avatar_url);
      $row.append($avatar);

      const $name = $('<span>', { class: 'group-call-participant__name', text: isMe ? p.user.name + ' (You)' : p.user.name });
      $row.append($name);

      if (isMe && state.localSpeaking && !state.muted) {
        $row.addClass('group-call-participant--speaking');
      }

      const statusParts = [];
      if (isMe) {
        statusParts.push(state.muted ? 'Muted' : 'Connected');
        if (state.cameraOn) statusParts.push('Camera on');
      } else {
        if (p.status === 'invited') {
          statusParts.push(STATUS_LABEL.invited);
        } else if (p.connectionState && CONNECTION_LABEL[p.connectionState]) {
          statusParts.push(CONNECTION_LABEL[p.connectionState]);
        } else {
          statusParts.push(STATUS_LABEL.joined);
        }
        if (p.muted) statusParts.push('Muted');
        if (p.cameraOn) statusParts.push('Camera on');
      }
      if (p.user.id === state.activeSharerId) statusParts.push('Sharing screen');
      $row.append($('<span>', { class: 'group-call-participant__status', text: statusParts.join(' · ') }));

      if (!isMe && p.muted) {
        $row.append($('<i>', { class: 'group-call-participant__mute-icon', 'data-lucide': 'mic-off', 'aria-hidden': 'true' }));
      }

      $panelList.append($row);
    });

    Ping.renderIcons($panelList[0]);
  }

  return {
    init: init,
    openStartModal: openStartModal,
    stopPolling: stopPolling,
    isActive: isActive
  };
})(jQuery);
