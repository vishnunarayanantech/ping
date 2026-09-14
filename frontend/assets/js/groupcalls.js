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
    // idle | incoming | active
    // "incoming": invited to a call, banner shown, not yet joined (no local
    // media acquired yet — same "never touch the mic before the user acts"
    // rule calls.js follows for an incoming 1:1 call).
    // "active": joined (or the creator, who auto-joins) — mic acquired,
    // bar + participant panel shown.
    phase: 'idle',
    callId: null,
    conversationId: null,
    creatorId: null,
    localStream: null,
    muted: false,
    localSpeaking: false,
    // userId -> { user, status: 'invited'|'joined', muted, connectionState: 'connecting'|'connected'|'failed'|null }
    // Built fresh from every poll's participants list (see
    // reconcileParticipants) — server-authoritative except connectionState,
    // which is this client's own WebRTC-level view of that peer.
    participants: new Map(),
    // userId -> { pc, audioEl }. One entry per OTHER participant this side
    // currently has (or is establishing) a live RTCPeerConnection with —
    // never one per signal, never one shared connection for the whole call.
    peers: new Map(),
    lastSignalId: 0,
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
    modalSelected: new Set()
  };

  let $appShell;
  let $banner, $bannerAvatar, $bannerCreator, $dismissBtn, $joinBtn;
  let $bar, $barCount, $muteBtn, $peopleBtn, $endBtn, $leaveBtn;
  let $panel, $panelList, $panelClose;
  let $audioContainer;
  let $modalOverlay, $modalHint, $modalList, $modalCancelBtn, $modalConfirmBtn, $modalCloseBtn;

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
    $peopleBtn = $('#groupCallPeopleBtn');
    $endBtn = $('#groupCallEndBtn');
    $leaveBtn = $('#groupCallLeaveBtn');

    $panel = $('#groupCallPanel');
    $panelList = $('#groupCallParticipantList');
    $panelClose = $('#groupCallPanelClose');

    $audioContainer = $('#groupCallAudioContainer');

    $modalOverlay = $('#groupCallStartModalOverlay');
    $modalHint = $('#groupCallStartModalHint');
    $modalList = $('#groupCallContactList');
    $modalCancelBtn = $('#groupCallStartCancelBtn');
    $modalConfirmBtn = $('#groupCallStartConfirmBtn');
    $modalCloseBtn = $('#groupCallStartModalClose');

    $joinBtn.on('click', joinIncoming);
    $dismissBtn.on('click', dismissIncoming);
    $muteBtn.on('click', toggleMute);
    $peopleBtn.on('click', togglePanel);
    $panelClose.on('click', togglePanel);
    $leaveBtn.on('click', leaveCall);
    $endBtn.on('click', endCallForEveryone);

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

    scheduleNextPoll();
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
    state.dismissedCallId = null;
    reconcileParticipants(call.participants);
    startSpeakingDetection();
    render();
    pollCallState();
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
    const peer = { pc: pc, pendingCandidates: [] };
    state.peers.set(userId, peer);
    setConnectionState(userId, 'connecting');

    pc.onicecandidate = function (e) {
      if (e.candidate) sendSignal(userId, 'ice-candidate', { candidate: e.candidate });
    };

    pc.ontrack = function (e) {
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
        // docstring.
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
    const peer = createPeerConnectionFor(userId);
    if (shouldInitiateTo(userId)) {
      peer.pc.createOffer()
        .then(function (offer) { return peer.pc.setLocalDescription(offer); })
        .then(function () { sendSignal(userId, 'offer', { sdp: peer.pc.localDescription }); })
        .catch(function () {
          setConnectionState(userId, 'failed');
          renderParticipants();
          teardownPeer(userId);
        });
    }
  }

  function teardownPeer(userId) {
    const peer = state.peers.get(userId);
    if (!peer) return;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.oniceconnectionstatechange = null;
    peer.pc.close();
    state.peers.delete(userId);
    removeAudioEl(userId);
  }

  function flushPendingCandidates(peer) {
    const candidates = peer.pendingCandidates;
    peer.pendingCandidates = [];
    candidates.forEach(function (candidate) {
      peer.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(function () {});
    });
  }

  function handleSignal(fromUserId, signal) {
    if (signal.message_type === 'mute-state') {
      const p = state.participants.get(fromUserId);
      if (p) p.muted = !!signal.payload.muted;
      renderParticipants();
      return;
    }

    let peer = state.peers.get(fromUserId);

    if (signal.message_type === 'offer') {
      if (!peer) peer = createPeerConnectionFor(fromUserId);
      peer.pc.setRemoteDescription(new RTCSessionDescription(signal.payload.sdp))
        .then(function () { return flushPendingCandidates(peer); })
        .then(function () { return peer.pc.createAnswer(); })
        .then(function (answer) { return peer.pc.setLocalDescription(answer); })
        .then(function () { sendSignal(fromUserId, 'answer', { sdp: peer.pc.localDescription }); })
        .catch(function () {
          setConnectionState(fromUserId, 'failed');
          renderParticipants();
          teardownPeer(fromUserId);
        });
      return;
    }

    if (signal.message_type === 'answer') {
      if (!peer) return; // stale — this side's own connection to them is already gone
      peer.pc.setRemoteDescription(new RTCSessionDescription(signal.payload.sdp))
        .then(function () { return flushPendingCandidates(peer); })
        .catch(function () {
          setConnectionState(fromUserId, 'failed');
          renderParticipants();
          teardownPeer(fromUserId);
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
    stopSpeakingDetection();

    state.pollGeneration++;
    state.phase = 'idle';
    state.callId = null;
    state.conversationId = null;
    state.creatorId = null;
    state.participants = new Map();
    state.muted = false;
    state.panelOpen = false;
    state.lastSignalId = 0;

    render();
    scheduleNextPoll();

    if (message) Ping.showToast(message, 'error');
  }

  // Best-effort cleanup if the tab/page is closed mid-call — fetch with
  // keepalive survives the page unloading, unlike a normal $.ajax request,
  // which the browser may abort before it's sent. Never blocks unload.
  window.addEventListener('pagehide', function () {
    if (state.phase === 'active' && state.callId) {
      const token = Ping.getToken();
      fetch(API_BASE_URL + '/calls/group/' + state.callId + '/leave', {
        method: 'POST',
        keepalive: true,
        headers: token ? { Authorization: 'Bearer ' + token } : {}
      }).catch(function () {});
    }
  });

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

    Ping.renderIcons($bar[0]);
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
      } else {
        if (p.status === 'invited') {
          statusParts.push(STATUS_LABEL.invited);
        } else if (p.connectionState && CONNECTION_LABEL[p.connectionState]) {
          statusParts.push(CONNECTION_LABEL[p.connectionState]);
        } else {
          statusParts.push(STATUS_LABEL.joined);
        }
        if (p.muted) statusParts.push('Muted');
      }
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
