/**
 * One-to-one audio/video calling: the call state machine, the WebRTC peer
 * connection, and the two reusable call UIs (the full-screen #callOverlay for
 * outgoing/incoming/the brief declined/missed/busy/failed/ended states, and
 * #activeCallBar + #callVideoPanel for connecting/connected — see render()).
 * Self-contained, like forward.js/media.js — owns all of that DOM entirely;
 * chat.js just calls Calls.startCall() from its header's audio/video call
 * buttons and otherwise knows nothing about calling.
 *
 * Video is an extension of the SAME call, not a second system: one Call row,
 * one signaling channel, one RTCPeerConnection, one poll loop. call_type
 * ("audio" | "video", fixed server-side at creation — see backend/models.py's
 * Call docstring) only ever changes (a) whether getUserMedia also asks for a
 * camera and (b) whether the video-specific DOM (preview/panel/camera button)
 * is shown; every state transition, signaling message, and teardown path
 * below is exactly the same for both. Camera on/off is just
 * MediaStreamTrack.enabled on the video track, mirroring how mute already
 * works for the audio track (see toggleMute/toggleCamera) — never a
 * renegotiation, never a second peer connection.
 *
 * Signaling (SDP offers/answers, ICE candidates) travels over the same
 * REST/JWT API as everything else in this app — see backend/routers/calls.py
 * — polled on ONE adaptive timer (scheduleNextPoll): a slow, CONVERSATION-
 * POLL-speed tick while idle just to notice an incoming call, switching to a
 * fast tick only for the duration of an actual call, so this never adds a
 * second always-on poll loop alongside Conversations'/Chat's. The instant a
 * call ends, polling drops back to idle speed. Swapping this transport for a
 * WebSocket later only means rewriting scheduleNextPoll/pollTick/sendSignal
 * — everything below that (createPeerConnection, handleSignal, mute, the
 * overlay itself) is written against plain state + callbacks, not against
 * "how a message arrives," so none of it would need to change.
 *
 * The actual microphone/camera/audio streaming NEVER goes through this API —
 * that's the whole point of WebRTC here (see RTCPeerConnection below): the
 * backend only ever relays small JSON blobs it never looks inside.
 */
const Calls = (function ($) {
  'use strict';

  // Messages shown briefly (see endWithReason) before the overlay closes and
  // the poll loop drops back to idle speed. Keyed by [reason][role] — a
  // combination with no entry here closes with no message at all (e.g. a
  // cancel/reject the LOCAL user just triggered themselves, or "cancelled"
  // on the receiver's side, which per spec just makes the incoming screen
  // disappear).
  const TRANSIENT_MESSAGES = {
    rejected: { caller: 'Call declined' },
    missed: { caller: 'No answer' },
    ended: { caller: 'Call ended', receiver: 'Call ended' },
    failed: { caller: 'Call failed', receiver: 'Call failed' }
  };
  const TRANSIENT_DISPLAY_MS = 2200;

  const state = {
    currentUser: null,
    iceServers: null,
    // idle | calling | incoming | connecting | connected | ended
    // ("ended" is the shared transient display for rejected/cancelled/
    // missed/busy/failed/ended — see endWithReason/render.)
    phase: 'idle',
    endReason: null,
    callId: null,
    role: null, // 'caller' | 'receiver'
    callType: 'audio', // 'audio' | 'video' — see backend/models.py's Call.call_type
    conversationId: null,
    otherUser: null,
    pc: null,
    localStream: null,
    muted: false,
    // Whether the local video track (if any) is currently enabled — kept as
    // its own flag rather than re-reading the track every render, since
    // there's also a "no video track at all" case (audio call, or a camera
    // that failed to acquire — see acquireLocalMedia) where this stays false
    // and the camera button is disabled rather than toggleable.
    cameraOn: false,
    remoteVideoTrack: null,
    // Whether the OTHER side's camera is currently on — driven by the
    // explicit 'camera-state' signal (see toggleCamera/handleSignal), not by
    // the video track's native muted state (unreliable — see
    // schemas.CALL_SIGNAL_TYPES's docstring). Defaults true: a peer's camera
    // is assumed on until they say otherwise, matching that video calls
    // start with the camera on (task requirement).
    remoteCameraOn: true,
    lastSignalId: 0,
    pendingOffer: null,
    pendingCandidates: [],
    // Bumped every time a call is torn down, so a poll response that was
    // already in flight for the OLD call can never mutate state for
    // whatever comes next — same "stale response after switching away"
    // guard chat.js's fetchAndRender uses via its conversationId check.
    pollGeneration: 0,
    pollTimer: null,
    // Separate flags (not one shared "a request is in flight") because
    // showIncoming() calls pollCallState() synchronously from INSIDE
    // pollForIncoming()'s own success handler — at that point the idle
    // poll's flight flag hasn't been cleared yet (its .always() hasn't run),
    // so a single shared flag would make that nested call think a request
    // was already running and silently skip fetching the offer.
    idlePollInFlight: false,
    activePollInFlight: false,
    durationTimer: null,
    callStartedAt: null,
    connectTimeoutTimer: null,
    endedDisplayTimer: null
  };

  // #callOverlay: the full-screen blocking panel — calling/incoming/ended only.
  let $overlay, $avatar, $previewVideo, $name, $typeLabel, $statusText, $actionsOutgoing, $actionsIncoming;
  // #activeCallBar: the compact, non-blocking bar — connecting/connected only.
  let $appShell, $activeBar, $activeBarAvatar, $activeBarName, $activeBarStatus, $muteBtn, $cameraBtn, $remoteAudio;
  // #callVideoPanel: video calls only, connecting/connected only — see renderVideoPanel.
  let $videoPanel, $videoPanelAvatar, $remoteVideo, $remotePlaceholder, $localVideo, $localPlaceholder;

  function init(currentUser) {
    state.currentUser = currentUser;

    $overlay = $('#callOverlay');
    $avatar = $('#callAvatar');
    $previewVideo = $('#callPreviewVideo');
    $name = $('#callName');
    $typeLabel = $('#callTypeLabel');
    $statusText = $('#callStatusText');
    $actionsOutgoing = $('#callActionsOutgoing');
    $actionsIncoming = $('#callActionsIncoming');

    $appShell = $('#appShell');
    $activeBar = $('#activeCallBar');
    $activeBarAvatar = $('#activeCallBarAvatar');
    $activeBarName = $('#activeCallBarName');
    $activeBarStatus = $('#activeCallBarStatus');
    $muteBtn = $('#activeCallMuteBtn');
    $cameraBtn = $('#activeCallCameraBtn');
    $remoteAudio = $('#callRemoteAudio');

    $videoPanel = $('#callVideoPanel');
    $videoPanelAvatar = $('#callVideoPanelAvatar');
    $remoteVideo = $('#callRemoteVideo');
    $remotePlaceholder = $('#callRemotePlaceholder');
    $localVideo = $('#callLocalVideo');
    $localPlaceholder = $('#callLocalPlaceholder');

    $('#callCancelBtn').on('click', cancelCall);
    $('#callRejectBtn').on('click', rejectCall);
    $('#callAcceptBtn').on('click', acceptCall);
    $('#activeCallEndBtn').on('click', hangup);
    $muteBtn.on('click', toggleMute);
    $cameraBtn.on('click', toggleCamera);

    // Fetched once and cached for the session — backend/config.py's
    // ICE_STUN_URLS/TURN_* env vars are the source of truth; this just
    // avoids a network round trip on every single call. Falls back to a
    // public STUN default if the request fails, so a signaling blip doesn't
    // block calling outright (see config.js's DEFAULT_ICE_SERVERS).
    Api.request({ url: '/calls/ice-servers' })
      .done(function (response) {
        state.iceServers = response.ice_servers;
      })
      .fail(function () {
        state.iceServers = DEFAULT_ICE_SERVERS;
      });

    scheduleNextPoll();
  }

  function rtcSupported() {
    return !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  // --- Polling --------------------------------------------------------

  function scheduleNextPoll() {
    clearTimeout(state.pollTimer);
    const delay = state.phase === 'idle' ? CALL_POLL_INTERVAL_IDLE_MS : CALL_POLL_INTERVAL_ACTIVE_MS;
    state.pollTimer = setTimeout(pollTick, delay);
  }

  function pollTick() {
    if (state.phase === 'idle') {
      pollForIncoming();
    } else if (state.callId) {
      pollCallState();
    } else {
      scheduleNextPoll();
    }
  }

  function pollForIncoming() {
    if (state.idlePollInFlight) {
      scheduleNextPoll();
      return;
    }
    state.idlePollInFlight = true;

    Api.request({ url: '/calls/active' })
      .done(function (response) {
        if (state.phase !== 'idle') return; // an outgoing call started locally in the meantime
        if (response.call && response.call.status === 'ringing' && response.call.receiver.id === state.currentUser.id) {
          showIncoming(response.call);
          return; // pollCallState takes over at active speed from here
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

    Api.request({ url: '/calls/' + callId + '?after_signal_id=' + state.lastSignalId })
      .done(function (response) {
        if (generation !== state.pollGeneration) return; // this call was reset/ended locally already
        handleCallUpdate(response.call, response.signals);
      })
      .fail(function (xhr) {
        if (generation !== state.pollGeneration) return;
        if (xhr.status === 403 || xhr.status === 404) {
          endWithReason('failed');
        }
        // Any other failure is treated as a transient network blip — the
        // next tick just tries again, same "silent on poll failures"
        // posture as chat.js/conversations.js.
      })
      .always(function () {
        state.activePollInFlight = false;
        if (generation === state.pollGeneration && state.phase !== 'idle') scheduleNextPoll();
      });
  }

  function handleCallUpdate(call, signals) {
    signals.forEach(function (signal) {
      state.lastSignalId = Math.max(state.lastSignalId, signal.id);
      handleSignal(signal);
    });

    switch (call.status) {
      case 'ringing':
        break; // nothing new
      case 'accepted':
        if (state.phase === 'calling') {
          state.phase = 'connecting';
          startConnectTimeout();
          render();
          checkIceConnected(); // ICE may have already connected before this transition ran — see its docstring
        }
        break;
      case 'rejected':
        endWithReason('rejected');
        break;
      case 'cancelled':
        endWithReason('cancelled');
        break;
      case 'missed':
        endWithReason('missed');
        break;
      case 'busy':
        endWithReason('busy');
        break;
      case 'ended':
        endWithReason('ended');
        break;
    }
  }

  // --- Media acquisition -------------------------------------------------

  /**
   * Wraps getUserMedia for both callers and receivers with the task's
   * "camera problems degrade, mic problems don't" contract: a single
   * combined { audio: true, video: true } request either succeeds outright,
   * or — if it fails — is retried as audio-only. If THAT also fails, the
   * mic itself (not the camera) was the real blocker, so the ORIGINAL
   * combined error is what propagates (rejecting with it), same as it would
   * for a plain audio call. Resolves to { stream, videoEnabled, downgraded,
   * cameraError } on success; `downgraded` is true only when video was
   * requested but the fallback had to drop it.
   */
  function acquireLocalMedia(wantVideo) {
    if (!wantVideo) {
      return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        .then(function (stream) { return { stream: stream, videoEnabled: false, downgraded: false }; });
    }
    return navigator.mediaDevices.getUserMedia({ audio: true, video: true })
      .then(function (stream) { return { stream: stream, videoEnabled: true, downgraded: false }; })
      .catch(function (cameraError) {
        return navigator.mediaDevices.getUserMedia({ audio: true, video: false })
          .then(function (stream) { return { stream: stream, videoEnabled: false, downgraded: true, cameraError: cameraError }; })
          .catch(function () {
            throw cameraError; // mic unavailable either way — nothing to downgrade to
          });
      });
  }

  // --- Outgoing call ----------------------------------------------------

  /** Called from chat.js's audio/video call buttons. callType defaults to
   * 'audio' so any caller that omits it keeps the original behavior. */
  function startCall(conversationId, otherUser, callType) {
    callType = callType === 'video' ? 'video' : 'audio';

    if (state.phase === 'ended') {
      // A brief "Call declined"/"Call ended"/etc. notice (see endWithReason)
      // is still showing from the PREVIOUS call — e.g. the other side just
      // hung up and this client's own poll only found out moments ago.
      // Don't let that lingering notice silently swallow a new call attempt
      // for the ~2s it would otherwise still be on screen — the user's new
      // action takes priority, so dismiss it immediately and proceed.
      resetToIdle();
    } else if (state.phase !== 'idle') {
      // Genuinely still on/starting a call (locally, or a poll simply
      // hasn't yet caught up to the other side having ended it) — give
      // clear feedback instead of silently doing nothing.
      Ping.showToast('You are already on a call.', 'error');
      return;
    }
    if (!rtcSupported()) {
      Ping.showToast('Your browser does not support ' + callType + ' calls.', 'error');
      return;
    }

    // Captured once and re-checked after every async step below (media
    // prompt, then two network round trips) — resetToIdle() bumps this on
    // ANY reset (a cancel click, or an unrelated incoming call answered
    // while this one was still being set up), so a mismatch here always
    // means "the world moved on, abandon this attempt without touching
    // whatever state now belongs to" instead of stomping it. Same
    // conversationId-staleness guard chat.js's fetchAndRender uses, just
    // keyed off this module's own generation counter since there's no
    // call id yet for most of this function.
    const myGeneration = state.pollGeneration;

    state.phase = 'calling';
    state.role = 'caller';
    state.callType = callType;
    state.conversationId = conversationId;
    state.otherUser = otherUser;
    state.lastSignalId = 0;
    render(); // instant "Calling…" feedback before the media prompt / network round trips below

    acquireLocalMedia(callType === 'video')
      .then(function (result) {
        if (state.pollGeneration !== myGeneration) {
          result.stream.getTracks().forEach(function (t) { t.stop(); });
          return Promise.reject({ superseded: true });
        }
        state.localStream = result.stream;
        state.cameraOn = result.videoEnabled;
        // The call is only ever as much "video" as media acquisition
        // actually managed — see acquireLocalMedia's docstring — so a
        // camera-denied/missing downgrade here is what backend/models.py's
        // Call.call_type ends up storing, not the button the user clicked.
        state.callType = result.videoEnabled ? 'video' : 'audio';
        if (result.downgraded) {
          Ping.showToast('Camera unavailable — continuing as an audio call.', 'error');
        }
        render(); // show the local camera preview (task requirement) the instant it's available
        return Api.request({
          url: '/calls',
          method: 'POST',
          data: { conversation_id: conversationId, call_type: state.callType }
        });
      })
      .then(function (response) {
        if (state.pollGeneration !== myGeneration) return Promise.reject({ superseded: true });

        const call = response.call;
        if (call.status === 'busy') {
          Ping.showToast('User is currently on another call.', 'error');
          return Promise.reject({ handled: true });
        }

        state.callId = call.id;
        createPeerConnection();
        addLocalTracks();
        return state.pc.createOffer();
      })
      .then(function (offer) {
        if (state.pollGeneration !== myGeneration) return Promise.reject({ superseded: true });
        return state.pc.setLocalDescription(offer);
      })
      .then(function () {
        if (state.pollGeneration !== myGeneration) return Promise.reject({ superseded: true });
        sendSignal('offer', { sdp: state.pc.localDescription });
        pollCallState(); // switch to active-speed polling (immediately, not after one idle-speed tick's delay) now that a call exists
      })
      .catch(function (err) {
        if (err && err.superseded) return; // already cleaned up / replaced elsewhere — don't touch shared state
        if (err && err.handled) {
          resetToIdle();
          return;
        }
        handleStartupError(err);
      });
  }

  function handleStartupError(err) {
    Ping.showToast(mediaErrorMessage(err), 'error');
    resetToIdle();
  }

  /**
   * Reads state.callType directly rather than taking a parameter — every
   * call site runs before resetToIdle() has had a chance to clear it, so it
   * still reflects what was actually being attempted (see acquireLocalMedia:
   * a camera-only failure never reaches here at all, it downgrades and
   * keeps going — only a combined/mic failure does, meaning "no audio-only
   * fallback was possible" for a video attempt too).
   */
  function mediaErrorMessage(err) {
    const isVideo = state.callType === 'video';
    const name = err && (err.name || (err.responseJSON && 'ApiError'));
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return isVideo
        ? 'Camera and microphone permission are required to make a video call.'
        : 'Microphone permission is required to make an audio call.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return isVideo
        ? 'No camera or microphone was found on this device.'
        : 'No microphone was found on this device.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'Your camera or microphone could not be accessed — it may be in use by another application.';
    }
    if (err && err.responseJSON && err.responseJSON.message) {
      return err.responseJSON.message;
    }
    return isVideo ? 'Unable to start the video call.' : 'Unable to start the call.';
  }

  // --- Incoming call ------------------------------------------------------

  function showIncoming(call) {
    state.phase = 'incoming';
    state.role = 'receiver';
    state.callId = call.id;
    state.callType = call.call_type;
    state.conversationId = call.conversation_id;
    state.otherUser = call.caller;
    state.lastSignalId = 0;
    render();
    // Poll immediately rather than merely scheduling one — the offer signal
    // (sent the moment the caller placed the call, likely already sitting on
    // the server) needs to be in state.pendingOffer before the user can
    // accept. Waiting out one full CALL_POLL_INTERVAL_ACTIVE_MS tick first
    // would let someone accept faster than that and hit acceptCall()'s
    // "no offer yet" rejection for no real reason.
    pollCallState();
  }

  function acceptCall() {
    if (state.phase !== 'incoming') return;
    if (!rtcSupported()) {
      Ping.showToast('Your browser does not support ' + state.callType + ' calls.', 'error');
      declineLocally();
      return;
    }

    const callId = state.callId;
    // Same "abandon without touching shared state if superseded" guard
    // startCall() uses — re-checked after every async step below, since a
    // reject/hangup/timeout, or even a completely different incoming call,
    // can land while any of these are still pending.
    const myGeneration = state.pollGeneration;
    const stillMine = function () { return state.pollGeneration === myGeneration && state.callId === callId; };

    // Camera + mic permission is requested HERE, at the moment the user
    // clicks Accept — never earlier (see showIncoming above), so an
    // incoming video call never touches the receiver's camera unless/until
    // they actually accept (task requirement).
    acquireLocalMedia(state.callType === 'video')
      .then(function (result) {
        if (!stillMine()) {
          result.stream.getTracks().forEach(function (t) { t.stop(); });
          return Promise.reject({ superseded: true });
        }
        state.localStream = result.stream;
        state.cameraOn = result.videoEnabled;
        if (result.downgraded) {
          Ping.showToast('Camera unavailable — joining with audio only.', 'error');
        }
        render(); // reflect the now-acquired local stream (camera button, PIP) as soon as it's ready
        createPeerConnection();
        addLocalTracks();
        if (!state.pendingOffer) return Promise.reject({ handled: true, message: 'The call ended before it could connect.' });
        return state.pc.setRemoteDescription(new RTCSessionDescription(state.pendingOffer));
      })
      .then(function () {
        if (!stillMine()) return Promise.reject({ superseded: true });
        return flushPendingCandidates();
      })
      .then(function () {
        if (!stillMine()) return Promise.reject({ superseded: true });
        return state.pc.createAnswer();
      })
      .then(function (answer) {
        if (!stillMine()) return Promise.reject({ superseded: true });
        return state.pc.setLocalDescription(answer);
      })
      .then(function () {
        if (!stillMine()) return Promise.reject({ superseded: true });
        return Api.request({ url: '/calls/' + callId + '/accept', method: 'POST' });
      })
      .then(function () {
        if (!stillMine()) return Promise.reject({ superseded: true });
        sendSignal('answer', { sdp: state.pc.localDescription });
        state.phase = 'connecting';
        startConnectTimeout();
        render();
        checkIceConnected(); // ICE may have already connected before this transition ran — see its docstring
      })
      .catch(function (err) {
        if (err && err.superseded) return; // already cleaned up / replaced elsewhere — don't touch shared state
        if (err && err.handled) {
          if (err.message) Ping.showToast(err.message, 'error');
          resetToIdle();
          return;
        }
        if (err && err.responseJSON) {
          Ping.showToast(Ping.getErrorMessage(err, 'This call is no longer available.'), 'error');
          resetToIdle();
          return;
        }
        handleStartupError(err);
      });
  }

  /** Reject without waiting on the backend to confirm mic support/etc. —
   * used when acceptCall() can't even attempt to proceed. */
  function declineLocally() {
    Api.request({ url: '/calls/' + state.callId + '/reject', method: 'POST' });
    resetToIdle();
  }

  function rejectCall() {
    if (state.phase !== 'incoming') return;
    Api.request({ url: '/calls/' + state.callId + '/reject', method: 'POST' });
    resetToIdle(); // silent for the person who just rejected — the caller learns via their own poll
  }

  function cancelCall() {
    if (state.phase !== 'calling') return;
    if (state.callId) {
      Api.request({ url: '/calls/' + state.callId + '/cancel', method: 'POST' });
    }
    resetToIdle(); // silent for the caller — receiver's incoming screen just disappears via their poll
  }

  function hangup() {
    if (state.phase !== 'connecting' && state.phase !== 'connected') return;
    if (state.callId) {
      Api.request({ url: '/calls/' + state.callId + '/hangup', method: 'POST' });
    }
    endWithReason('ended', true); // silent for whoever clicked it; the other side sees "Call ended" via poll
  }

  // --- WebRTC ---------------------------------------------------------

  function createPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: state.iceServers || DEFAULT_ICE_SERVERS });

    pc.onicecandidate = function (e) {
      if (e.candidate) sendSignal('ice-candidate', { candidate: e.candidate });
    };

    pc.ontrack = function (e) {
      if (e.track.kind === 'video') {
        // The receiver side of the SAME call/offer this whole module already
        // negotiates — never a second connection. Only ever fires for a
        // video call (an audio call's SDP has no video m-line at all), so
        // this is fully inert for audio calls, matching the task's "extend,
        // don't fork" requirement.
        $remoteVideo[0].srcObject = e.streams[0];
        state.remoteVideoTrack = e.track;
        // A track that arrives already muted (e.g. the sender started with
        // its camera off) needs the placeholder shown immediately, not just
        // on the next mute/unmute event.
        updateRemoteVideoVisibility();
        e.track.onmute = updateRemoteVideoVisibility;
        e.track.onunmute = updateRemoteVideoVisibility;
        e.track.onended = updateRemoteVideoVisibility;
      } else {
        $remoteAudio[0].srcObject = e.streams[0];
      }
    };

    pc.oniceconnectionstatechange = function () {
      const cs = pc.iceConnectionState;
      if (cs === 'connected' || cs === 'completed') {
        checkIceConnected();
      } else if (cs === 'failed') {
        if (state.callId) Api.request({ url: '/calls/' + state.callId + '/hangup', method: 'POST' });
        endWithReason('failed');
      }
    };

    state.pc = pc;
  }

  /**
   * Promotes 'connecting' -> 'connected' once ICE actually reports it.
   * Called both from oniceconnectionstatechange above AND right after
   * setting state.phase = 'connecting' in acceptCall()/handleCallUpdate() —
   * on two peers on the same machine/LAN, ICE connectivity checks can finish
   * (and fire that event) BEFORE this module gets around to setting
   * state.phase = 'connecting' at all (it happens after createAnswer/
   * setLocalDescription/the accept POST's round trip) — an event-only check
   * would miss that already-past transition and leave the UI stuck showing
   * "Connecting…" forever despite audio already flowing.
   */
  function checkIceConnected() {
    if (!state.pc || state.phase !== 'connecting') return;
    const cs = state.pc.iceConnectionState;
    if (cs !== 'connected' && cs !== 'completed') return;
    clearTimeout(state.connectTimeoutTimer);
    state.phase = 'connected';
    state.callStartedAt = Date.now();
    startDurationTimer();
    render();
  }

  function addLocalTracks() {
    state.localStream.getTracks().forEach(function (track) {
      state.pc.addTrack(track, state.localStream);
    });
  }

  function handleSignal(signal) {
    if (signal.message_type === 'offer') {
      state.pendingOffer = signal.payload.sdp;
      return;
    }

    if (signal.message_type === 'answer') {
      if (state.pc && state.role === 'caller') {
        state.pc.setRemoteDescription(new RTCSessionDescription(signal.payload.sdp)).then(flushPendingCandidates);
      }
      return;
    }

    if (signal.message_type === 'ice-candidate') {
      if (state.pc && state.pc.remoteDescription && state.pc.remoteDescription.type) {
        state.pc.addIceCandidate(new RTCIceCandidate(signal.payload.candidate)).catch(function () {
          // A candidate arriving after the connection already settled (or
          // one the browser just doesn't like) isn't fatal — WebRTC only
          // needs enough candidates to find ONE working path.
        });
      } else {
        state.pendingCandidates.push(signal.payload.candidate);
      }
      return;
    }

    if (signal.message_type === 'camera-state') {
      state.remoteCameraOn = !!signal.payload.enabled;
      updateRemoteVideoVisibility();
    }
  }

  function flushPendingCandidates() {
    const candidates = state.pendingCandidates;
    state.pendingCandidates = [];
    candidates.forEach(function (candidate) {
      state.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(function () {});
    });
  }

  function sendSignal(messageType, payload) {
    if (!state.callId) return;
    Api.request({
      url: '/calls/' + state.callId + '/signals',
      method: 'POST',
      data: { message_type: messageType, payload: payload }
    });
  }

  function startConnectTimeout() {
    clearTimeout(state.connectTimeoutTimer);
    state.connectTimeoutTimer = setTimeout(function () {
      if (state.phase === 'connecting') {
        if (state.callId) Api.request({ url: '/calls/' + state.callId + '/hangup', method: 'POST' });
        endWithReason('failed');
      }
    }, CALL_CONNECT_TIMEOUT_MS);
  }

  // --- Mute -------------------------------------------------------------

  function toggleMute() {
    if (!state.localStream) return;
    state.muted = !state.muted;
    state.localStream.getAudioTracks().forEach(function (track) {
      track.enabled = !state.muted; // stops sending audio without touching the call itself — see task's mute contract
    });
    renderMuteButton();
  }

  function renderMuteButton() {
    $muteBtn
      .toggleClass('is-active', state.muted)
      .attr('aria-label', state.muted ? 'Unmute microphone' : 'Mute microphone')
      .attr('title', state.muted ? 'Unmute' : 'Mute')
      .find('i')
      .attr('data-lucide', state.muted ? 'mic-off' : 'mic');
    Ping.renderIcons($muteBtn[0]);
  }

  // --- Camera -------------------------------------------------------------
  // Entirely independent of mute above — a separate track, a separate flag,
  // a separate button (task requirement: mic/camera never coupled). Only
  // ever reachable for a video call with a live local video track; see
  // hasVideoTrack() and renderCameraButton()'s :disabled handling for the
  // "downgraded to audio, nothing to toggle" case.

  function hasVideoTrack() {
    return !!(state.localStream && state.localStream.getVideoTracks().length);
  }

  function toggleCamera() {
    if (!hasVideoTrack()) return;
    state.cameraOn = !state.cameraOn;
    state.localStream.getVideoTracks().forEach(function (track) {
      track.enabled = state.cameraOn; // same "disable the track, keep the connection" mechanism toggleMute uses
    });
    // Tells the other side to show its placeholder instead of a frozen/black
    // frame — see schemas.CALL_SIGNAL_TYPES's docstring for why this can't
    // just rely on the video track's native muted state.
    sendSignal('camera-state', { enabled: state.cameraOn });
    render();
  }

  function renderCameraButton() {
    const enabled = hasVideoTrack();
    $cameraBtn
      .prop('disabled', !enabled)
      .toggleClass('is-active', enabled && !state.cameraOn)
      .attr('aria-label', state.cameraOn ? 'Turn off camera' : 'Turn on camera')
      .attr('title', enabled ? (state.cameraOn ? 'Turn off camera' : 'Turn on camera') : 'Camera unavailable')
      .find('i')
      .attr('data-lucide', state.cameraOn ? 'video' : 'video-off');
    Ping.renderIcons($cameraBtn[0]);
  }

  /** Attaches/detaches the remote <video> vs. its placeholder — covers all
   * three of the task's remote states: no video track at all (placeholder
   * stays up, since state.remoteVideoTrack is simply never set — see
   * createPeerConnection's ontrack), video enabled, and video disabled (the
   * OTHER side toggled their camera off — see the 'camera-state' signal
   * above; track.muted is also checked as a defensive extra for a real
   * network-level interruption, on top of that explicit signal). */
  function updateRemoteVideoVisibility() {
    const track = state.remoteVideoTrack;
    const active = !!track && track.readyState === 'live' && !track.muted && state.remoteCameraOn;
    $remoteVideo.prop('hidden', !active);
    $remotePlaceholder.prop('hidden', active);
  }

  /** Mirrors updateRemoteVideoVisibility for the LOCAL PIP — placeholder
   * shown whenever there's no enabled local video track, whether that's
   * because this side toggled its own camera off or never had one to begin
   * with (audio call, or a downgraded video call — see acquireLocalMedia). */
  function renderLocalVideoPip() {
    const active = hasVideoTrack() && state.cameraOn;
    if (active && $localVideo[0].srcObject !== state.localStream) {
      $localVideo[0].srcObject = state.localStream;
    }
    $localVideo.prop('hidden', !active);
    $localPlaceholder.prop('hidden', active);
  }

  // --- Teardown / reset -------------------------------------------------

  function cleanupRtc() {
    if (state.localStream) {
      // .stop() on a video track is what actually turns off the camera
      // hardware/indicator light, same as it already does for the
      // microphone — one generic loop over every track this stream has,
      // audio or video, so nothing video-specific was needed here at all
      // (task requirement: no camera left running after the call ends).
      state.localStream.getTracks().forEach(function (t) { t.stop(); });
      state.localStream = null;
    }
    if (state.pc) {
      state.pc.onicecandidate = null;
      state.pc.ontrack = null;
      state.pc.oniceconnectionstatechange = null;
      state.pc.close();
      state.pc = null;
    }
    if (state.remoteVideoTrack) {
      state.remoteVideoTrack.onmute = null;
      state.remoteVideoTrack.onunmute = null;
      state.remoteVideoTrack.onended = null;
      state.remoteVideoTrack = null;
    }
    $remoteAudio[0].srcObject = null;
    $remoteVideo[0].srcObject = null;
    $localVideo[0].srcObject = null;
    $previewVideo[0].srcObject = null;
    clearInterval(state.durationTimer);
    state.durationTimer = null;
    clearTimeout(state.connectTimeoutTimer);
    state.connectTimeoutTimer = null;
  }

  /**
   * Ends the current call, showing a brief status screen first when one
   * applies to this side's role (see TRANSIENT_MESSAGES) before returning to
   * idle — or immediately/silently when `silent` is true, e.g. for
   * hangup()/cancelCall()/rejectCall() acting on the local user's OWN click.
   */
  function endWithReason(reason, silent) {
    cleanupRtc();
    const message = !silent && TRANSIENT_MESSAGES[reason] && TRANSIENT_MESSAGES[reason][state.role];

    if (reason === 'missed' && state.role === 'receiver') {
      Ping.showToast('Missed call from ' + (state.otherUser ? state.otherUser.name : 'someone'), 'error');
    }

    if (!message) {
      resetToIdle();
      return;
    }

    state.phase = 'ended';
    state.endReason = reason;
    render();
    state.endedDisplayTimer = setTimeout(resetToIdle, TRANSIENT_DISPLAY_MS);
  }

  function resetToIdle() {
    // Cancel the transient "Call declined"/"Call ended"/etc. auto-dismiss
    // timer (see endWithReason) whenever THIS runs for any other reason
    // first — e.g. startCall() dismissing it early to place a new call
    // right away. Without this, that original timer stays pending and
    // fires ~TRANSIENT_DISPLAY_MS later regardless, wiping out whatever
    // brand new call's state has since taken over (wrong callId, wrong
    // phase, wrong everything) — clearTimeout on an already-fired timer is
    // always a harmless no-op, so it's safe to do unconditionally here.
    clearTimeout(state.endedDisplayTimer);
    state.endedDisplayTimer = null;

    cleanupRtc();
    state.pollGeneration++; // invalidate any in-flight poll tied to the old call
    state.phase = 'idle';
    state.endReason = null;
    state.callId = null;
    state.role = null;
    state.callType = 'audio';
    state.conversationId = null;
    state.otherUser = null;
    state.lastSignalId = 0;
    state.pendingOffer = null;
    state.pendingCandidates = [];
    state.muted = false;
    state.cameraOn = false;
    state.remoteCameraOn = true;
    state.callStartedAt = null;
    render();
    scheduleNextPoll();
  }

  // --- Duration timer -----------------------------------------------------

  function startDurationTimer() {
    clearInterval(state.durationTimer);
    updateTimerText();
    state.durationTimer = setInterval(updateTimerText, 1000);
  }

  function updateTimerText() {
    if (state.phase !== 'connected') return;
    const seconds = Math.max(0, Math.floor((Date.now() - state.callStartedAt) / 1000));
    const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
    const ss = String(seconds % 60).padStart(2, '0');
    $activeBarStatus.text(mm + ':' + ss);
  }

  // --- Rendering ------------------------------------------------------

  // Phases handled by the full-screen #callOverlay — a decision (calling/
  // incoming) or a brief result notice (ended). "connecting"/"connected"
  // are deliberately absent: those go through #activeCallBar instead (see
  // render() below) so the chat stays usable once a call is actually
  // under way.
  const OVERLAY_PHASES = { calling: true, incoming: true, ended: true };

  const STATUS_TEXT = {
    calling: 'Calling…',
    incoming: ' is calling',
    ended: {
      rejected: 'Call declined',
      cancelled: 'Call ended',
      missed: 'No answer',
      busy: 'User is currently on another call',
      ended: 'Call ended',
      failed: 'Call failed'
    }
  };

  function render() {
    renderOverlay();
    renderActiveBar();
    renderVideoPanel();
  }

  function renderOverlay() {
    const show = !!OVERLAY_PHASES[state.phase];
    $overlay.prop('hidden', !show);
    if (!show) return;

    $overlay.attr('data-call-phase', state.phase);

    // Outgoing video call, local media already acquired: show the caller's
    // own camera feed in place of the avatar (task requirement — never for
    // "incoming", since the receiver's camera isn't touched before accept).
    const showPreview = state.phase === 'calling' && hasVideoTrack() && state.cameraOn;
    if (showPreview) {
      if ($previewVideo[0].srcObject !== state.localStream) $previewVideo[0].srcObject = state.localStream;
    } else if ($previewVideo[0].srcObject) {
      $previewVideo[0].srcObject = null;
    }
    $previewVideo.prop('hidden', !showPreview);
    $avatar.prop('hidden', showPreview);

    if (state.otherUser) {
      Avatars.apply($avatar, state.otherUser.name, state.otherUser.avatar_url);
      $name.text(state.otherUser.name);
    }

    $typeLabel.prop('hidden', state.callType !== 'video' || state.phase === 'ended');

    $actionsOutgoing.prop('hidden', state.phase !== 'calling');
    $actionsIncoming.prop('hidden', state.phase !== 'incoming');

    if (state.phase === 'incoming') {
      $statusText.text((state.otherUser ? state.otherUser.name : 'Someone') + STATUS_TEXT.incoming);
    } else if (state.phase === 'ended') {
      $statusText.text(STATUS_TEXT.ended[state.endReason] || 'Call ended');
    } else {
      $statusText.text(STATUS_TEXT[state.phase] || '');
    }
  }

  function renderActiveBar() {
    const show = state.phase === 'connecting' || state.phase === 'connected';
    $appShell.toggleClass('app-shell--call-bar', show);
    $activeBar.prop('hidden', !show);
    if (!show) return;

    if (state.otherUser) {
      Avatars.apply($activeBarAvatar, state.otherUser.name, state.otherUser.avatar_url);
      $activeBarName.text(state.otherUser.name);
    }
    if (state.phase === 'connecting') {
      $activeBarStatus.text('Connecting…');
    } else {
      updateTimerText(); // "Connected" itself is implied by the running timer
    }
    renderMuteButton();

    // Hidden entirely for an audio call — see the button's `hidden` default
    // in dashboard/index.html — so an audio call's bar never even has a
    // camera icon to look at, let alone a functioning one.
    $cameraBtn.prop('hidden', state.callType !== 'video');
    if (state.callType === 'video') renderCameraButton();
  }

  function renderVideoPanel() {
    const show = state.callType === 'video' && (state.phase === 'connecting' || state.phase === 'connected');
    $videoPanel.prop('hidden', !show);
    if (!show) {
      // Belt-and-braces: also cleared in cleanupRtc() on every teardown
      // path, but clearing here too means a stale frame never lingers even
      // for the instant between phase changing and cleanupRtc() running.
      $remoteVideo[0].srcObject = null;
      $localVideo[0].srcObject = null;
      return;
    }
    if (state.otherUser) Avatars.apply($videoPanelAvatar, state.otherUser.name, state.otherUser.avatar_url);
    updateRemoteVideoVisibility();
    renderLocalVideoPip();
  }

  function stopPolling() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  return {
    init: init,
    startCall: startCall,
    stopPolling: stopPolling
  };
})(jQuery);
