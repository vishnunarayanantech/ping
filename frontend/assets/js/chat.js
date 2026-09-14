/**
 * Conversation state, message rendering, sending, and lightweight polling.
 * Owns the chat area's DOM; dashboard.js just calls Chat.init() once, then
 * Chat.openConversation(conversationId, otherUser) whenever a sidebar item
 * or search result resolves to a conversation.
 *
 * No WebSockets yet — while a conversation is open, we just re-fetch every
 * POLL_INTERVAL_MS and reconcile the response into the existing DOM (see
 * reconcileMessages) rather than replacing the message list wholesale, so
 * polling stays visually silent when nothing changed instead of flickering
 * every row on every tick. startPolling() / stopPolling() are the seam a
 * future WebSocket connection would plug into.
 */
const Chat = (function ($) {
  'use strict';

  const POLL_INTERVAL_MS = 5000;
  const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '😡', '🎉', '👏'];

  const state = {
    currentUser: null,
    conversationId: null,
    otherUser: null,
    messages: [],
    lastMarkedMessageId: null,
    pollHandle: null,
    // Guards fetchAndRender against overlapping requests (a slow poll tick
    // still in flight when the next timer fires) - same pattern as
    // Conversations' pollInFlight, so a stale response can never land after
    // a newer one already rendered.
    pollInFlight: false,
    // Which message (if any) currently has its emoji picker open — a render
    // flag, not fetched state, so it survives renderMessages() being called
    // again (poll ticks, sends, reactions) instead of getting wiped along
    // with the rest of the message DOM every time.
    openPickerMessageId: null,
    // The message (a full entry from state.messages) the composer is
    // currently replying to, or null. Also just a render flag — cleared on
    // send, cancel, or switching/closing conversations.
    replyTo: null,
    // The message (a full entry from state.messages) the composer is
    // currently editing, or null. Mutually exclusive with replyTo — starting
    // one clears the other, same "render flag, not fetched state" reasoning
    // as replyTo above. See startEdit/cancelEdit/saveEdit.
    editingMessage: null
  };

  let $shell, $empty, $conversation, $headerAvatar, $headerName,
    $messages, $form, $input, $sendBtn,
    $replyPreview, $replyPreviewSender, $replyPreviewContent, $replyPreviewClose;

  function init(currentUser) {
    state.currentUser = currentUser;

    $shell = $('#appShell');
    $empty = $('#chatEmpty');
    $conversation = $('#chatConversation');
    $headerAvatar = $('#chatHeaderInitials');
    $headerName = $('#chatHeaderName');
    $messages = $('#chatMessages');
    $form = $('#messageForm');
    $input = $('#messageInput');
    $sendBtn = $('#sendBtn');
    $replyPreview = $('#replyPreview');
    $replyPreviewSender = $('#replyPreviewSender');
    $replyPreviewContent = $('#replyPreviewContent');
    $replyPreviewClose = $('#replyPreviewClose');

    $input.on('input', function () {
      $sendBtn.prop('disabled', $input.val().trim() === '');
    });

    $form.on('submit', function (e) {
      e.preventDefault();
      if (state.editingMessage) {
        saveEdit();
      } else {
        send();
      }
    });

    $('#chatBackBtn').on('click', closeConversation);

    // The chat header's own DOM (see main.js-style ownership elsewhere in
    // this file) — calls.js owns everything about the call itself (state
    // machine, WebRTC, the call overlay), this just tells it which
    // conversation/person to call, same "chat.js owns the button, calls the
    // other module's open()" pattern startForward uses for the forward button.
    $('#callBtn').on('click', function () {
      if (!state.conversationId) return;
      Calls.startCall(state.conversationId, state.otherUser, 'audio');
    });

    $('#videoCallBtn').on('click', function () {
      if (!state.conversationId) return;
      Calls.startCall(state.conversationId, state.otherUser, 'video');
    });

    // groupcalls.js owns everything about a group call the same way
    // calls.js owns 1:1 calling — this just tells it which conversation to
    // start one from, same pattern as the two buttons above.
    $('#groupCallBtn').on('click', function () {
      if (!state.conversationId) return;
      GroupCalls.openStartModal(state.conversationId, state.otherUser);
    });

    // Same close button drives both the reply preview and the edit preview
    // (they're the same bar — see renderReplyPreview) — whichever one is
    // actually active is what Escape/this click cancels.
    $replyPreviewClose.on('click', function () {
      if (state.editingMessage) {
        cancelEdit();
      } else {
        cancelReply();
      }
    });

    // Emoji picker: close on outside click / Escape, same pattern as the
    // profile page's user-menu dropdown. The picker's own open/close click
    // (below, in renderMessages) stops propagation so it doesn't immediately
    // re-close what it just opened.
    $(document).on('click', function () {
      closeOpenPicker();
    });

    $(document).on('keydown', function (e) {
      if (e.key === 'Escape') {
        closeOpenPicker();
        cancelEdit();
      }
    });
  }

  function openConversation(conversationId, otherUser) {
    stopPolling();
    state.conversationId = conversationId;
    state.otherUser = otherUser;
    state.messages = [];
    state.lastMarkedMessageId = null;
    state.openPickerMessageId = null;
    state.replyTo = null;
    state.editingMessage = null;
    // A request left over from whatever conversation was open before is
    // about to be made moot by the conversationId change above (see the
    // stale-conversation check in fetchAndRender) - don't let its eventual
    // .always() reset leave this flag in the wrong state for the new
    // conversation's own fetch below.
    state.pollInFlight = false;

    $shell.addClass('app-shell--conversation-open');
    $empty.prop('hidden', true);
    $conversation.prop('hidden', false);

    Avatars.apply($headerAvatar, otherUser.name, otherUser.avatar_url);
    $headerName.text(otherUser.name);

    $input.val('');
    $sendBtn.prop('disabled', true);
    renderReplyPreview();

    fetchAndRender(true);
    startPolling();

    $input.trigger('focus');
  }

  function closeOpenPicker() {
    if (state.openPickerMessageId === null) return;
    const id = state.openPickerMessageId;
    state.openPickerMessageId = null;
    rerenderRow(id);
  }

  function closeConversation() {
    stopPolling();
    state.conversationId = null;
    state.otherUser = null;
    state.lastMarkedMessageId = null;
    state.openPickerMessageId = null;
    state.replyTo = null;
    state.editingMessage = null;
    $shell.removeClass('app-shell--conversation-open');
    $conversation.prop('hidden', true);
    $empty.prop('hidden', false);
  }

  function senderDisplayName(senderId) {
    return senderId === state.currentUser.id ? 'You' : state.otherUser.name;
  }

  /**
   * Display name for a *forwarded* message's original sender. Unlike
   * senderDisplayName above, this can't assume the two-party context of the
   * currently open conversation — the original message may have come from a
   * conversation with a third person entirely. Falls back to the name the
   * backend resolved (schemas.ForwardPreview.sender_name), only special-
   * casing the current user as "You" the same way the rest of the app does.
   */
  function forwardedSenderDisplayName(forwardedFrom) {
    return forwardedFrom.sender_id === state.currentUser.id ? 'You' : forwardedFrom.sender_name;
  }

  /** Open the forward-message modal for a message, called from the
   * row-hover forward button. */
  function startForward(message) {
    Forward.open(message, senderDisplayName(message.sender_id));
  }

  /**
   * Called by forward.js once a forward request succeeds. Only the newly
   * created messages that landed in the conversation currently open here
   * need to appear immediately — anything forwarded into other
   * conversations will show up next time those are opened (or via their own
   * poll, if already open in a way this module doesn't know about).
   */
  function handleForwarded(forwardedMessages) {
    const relevant = forwardedMessages.filter(function (m) { return m.conversation_id === state.conversationId; });
    if (!relevant.length) return;

    relevant.forEach(function (m) { state.messages.push(m); });
    state.lastMarkedMessageId = relevant[relevant.length - 1].id; // our own forwarded message never needs marking read
    renderMessages(true);
  }

  /**
   * Called by upload.js once a file-share upload succeeds. Only renders it
   * if the target conversation is still the one open here — same "ignore
   * if the user switched away" filtering as handleForwarded above, just for
   * a single message instead of a batch.
   */
  function handleFileUploaded(message) {
    if (message.conversation_id !== state.conversationId) return;

    state.messages.push(message);
    state.lastMarkedMessageId = message.id; // our own upload never needs marking read
    cancelReply(); // mirror send()'s success behavior — same reasoning as there
    cancelEdit(); // an upload is a new message, not the edit (if any) in progress — don't leave stale edit state behind
    renderMessages(true);
  }

  /** The conversation currently open, or null — upload.js needs this to
   * know which conversation a file picked from the composer belongs to. */
  function getConversationId() {
    return state.conversationId;
  }

  /** The other participant of the conversation currently open, or null —
   * calls.js needs this (avatar/name) to start an outgoing call from the
   * chat header's call button. Same "just a getter, not owned here" role as
   * getConversationId above. */
  function getOtherUser() {
    return state.otherUser;
  }

  /** Set the message the composer is replying to and show its preview above
   * the input. Called from the row-hover reply button. */
  function startReply(message) {
    state.editingMessage = null; // mutually exclusive with editing — see state.editingMessage
    state.replyTo = message;
    renderReplyPreview();
    $input.trigger('focus');
  }

  function cancelReply() {
    if (state.replyTo === null) return;
    state.replyTo = null;
    renderReplyPreview();
  }

  /** Only the sender's own, plain text messages are editable in this UI — a
   * file-share message's content is never rendered (buildFileOrMediaBlock
   * shows the file block instead, same as a forwarded message's content is
   * never rendered — buildForwardBlock shows forwarded_from.content
   * instead), so "editing" either would change a value nothing on screen
   * ever displays. The backend doesn't need this same restriction: it's a
   * UI-only scoping decision, not a security boundary (see edit_message's
   * ownership check for that). */
  function canEditMessage(message) {
    return message.sender_id === state.currentUser.id && !message.file && !message.forwarded_from;
  }

  /** Put a message's text into the composer for editing and show the
   * editing-state bar above it. Called from the row-hover edit button
   * (only rendered for messages canEditMessage() allows). */
  function startEdit(message) {
    state.replyTo = null; // mutually exclusive with replying — see state.replyTo
    state.editingMessage = message;
    $input.val(message.content);
    $sendBtn.prop('disabled', message.content.trim() === '');
    renderReplyPreview();
    $input.trigger('focus');
  }

  /** Exit edit mode and restore the normal composer — used both by the
   * Cancel button and after a successful save. */
  function cancelEdit() {
    if (state.editingMessage === null) return;
    state.editingMessage = null;
    $input.val('');
    $sendBtn.prop('disabled', true);
    renderReplyPreview();
  }

  /**
   * Same bar renders either the reply-target preview or the editing-state
   * preview — they're mutually exclusive (see startReply/startEdit) and
   * share the same "colored bar + label + content + close button" shape
   * (compare the reply-preview and .reply-preview--edit CSS), so this picks
   * whichever is active rather than keeping two separate DOM blocks in sync.
   */
  function renderReplyPreview() {
    if (state.editingMessage) {
      $replyPreview.addClass('reply-preview--edit');
      $replyPreviewSender.text('Editing message');
      $replyPreviewContent.text(state.editingMessage.content);
      $replyPreviewClose.attr('aria-label', 'Cancel edit');
      $replyPreview.prop('hidden', false);
      return;
    }

    $replyPreview.removeClass('reply-preview--edit');
    $replyPreviewClose.attr('aria-label', 'Cancel reply');

    if (!state.replyTo) {
      $replyPreview.prop('hidden', true);
      return;
    }
    $replyPreviewSender.text(senderDisplayName(state.replyTo.sender_id));
    $replyPreviewContent.text(state.replyTo.content);
    $replyPreview.prop('hidden', false);
  }

  /**
   * Copy a message's text to the clipboard — available on every message
   * regardless of sender or type. message.content is always plain text
   * (a file-share message's is its "📎 <filename>" caption, a forwarded
   * message's is the forwarded text itself — see models.MessageFile's
   * docstring for why the actual file bytes never pass through here), so
   * there's never anything binary to guard against copying.
   */
  function copyMessageContent(message) {
    copyTextToClipboard(message.content || '')
      .then(function () {
        Ping.showToast('Copied to clipboard', 'success');
      })
      .catch(function () {
        Ping.showToast('Unable to copy message.', 'error');
      });
  }

  /**
   * navigator.clipboard requires a secure context (HTTPS, or localhost) —
   * true for this app's normal dev/deploy origins, but not guaranteed for
   * every future one (e.g. plain-http on a LAN IP). Falls back to the
   * classic hidden-textarea + execCommand('copy') trick so Copy still works
   * there instead of silently doing nothing.
   */
  function copyTextToClipboard(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        const $tmp = $('<textarea>', { readonly: true })
          .val(text)
          .css({ position: 'fixed', top: '-1000px', left: '-1000px', opacity: 0 });
        $('body').append($tmp);
        $tmp[0].select();
        const copied = document.execCommand('copy');
        $tmp.remove();
        if (copied) {
          resolve();
        } else {
          reject(new Error('execCommand copy failed'));
        }
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Scroll a quoted message's original into view and briefly highlight it.
   * Every message in the open conversation is always rendered at once (no
   * pagination — see fetchAndRender), so the target is always in the DOM
   * already; nothing to fetch.
   */
  function scrollToMessage(messageId) {
    const $target = $messages.find('.message-row[data-message-id="' + messageId + '"]');
    if (!$target.length) return;
    $target[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    $target.addClass('message-row--highlight');
    setTimeout(function () {
      $target.removeClass('message-row--highlight');
    }, 1500);
  }

  function fetchAndRender(showLoading) {
    if (!state.conversationId) return;
    if (state.pollInFlight) return; // never let requests overlap - RULE 11
    state.pollInFlight = true;
    const conversationId = state.conversationId;

    if (showLoading) {
      renderLoading();
    }

    return Api.request({ url: '/messages/conversation/' + conversationId })
      .done(function (response) {
        if (state.conversationId !== conversationId) return; // user switched away while this was in flight
        const stayAtBottom = showLoading || isNearBottom();
        state.messages = response.messages;
        renderMessages(stayAtBottom);
        markReadIfNeeded(conversationId);
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return; // api.js is already redirecting to login
        if (showLoading) {
          renderError(Ping.getErrorMessage(xhr, 'Unable to load messages.'));
        }
        // Silent on poll failures — a blip shouldn't disrupt an open conversation.
      })
      .always(function () {
        state.pollInFlight = false;
      });
  }

  /**
   * RULE 1 / RULE 3: mark the conversation read once messages are actually
   * loaded — never just because it was clicked open. Skips the request
   * entirely if nothing new has arrived since the last time this exact
   * conversation was marked read (e.g. an empty conversation, or a poll
   * tick with no new messages), so an open chat doesn't POST every 5s.
   */
  function markReadIfNeeded(conversationId) {
    const latest = state.messages.length ? state.messages[state.messages.length - 1] : null;
    const latestId = latest ? latest.id : null;
    if (latestId === state.lastMarkedMessageId) return;

    state.lastMarkedMessageId = latestId;
    Conversations.markRead(conversationId);
  }

  /** Was the user already scrolled near the bottom before this render? Used
   * so a poll tick never yanks someone back down while they're reading
   * older messages further up. */
  function isNearBottom() {
    if (!$messages.length) return true;
    const el = $messages[0];
    const BOTTOM_THRESHOLD_PX = 80;
    return el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_THRESHOLD_PX;
  }

  function send() {
    const content = $input.val().trim();
    if (!content || !state.conversationId) return;

    const payload = { conversation_id: state.conversationId, content: content };
    if (state.replyTo) {
      payload.reply_to_message_id = state.replyTo.id;
    }

    $sendBtn.prop('disabled', true);

    Api.request({
      url: '/messages',
      method: 'POST',
      data: payload
    })
      .done(function (response) {
        state.messages.push(response.message);
        state.lastMarkedMessageId = response.message.id; // our own message never needs marking read
        cancelReply(); // only on success — a failed send keeps the reply context so retry doesn't lose it, same as the input text below
        renderMessages(true);
        $input.val('');
        Conversations.refresh();
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return;
        Ping.showToast(Ping.getErrorMessage(xhr, 'Message failed to send.'), 'error');
      })
      .always(function () {
        $sendBtn.prop('disabled', $input.val().trim() === '');
        $input.trigger('focus');
      });
  }

  /**
   * Save an in-progress edit (see startEdit). Updates the existing message
   * row in place via PUT — never pushes a new entry onto state.messages
   * the way send() does, and only re-renders the one affected row (like
   * toggleReaction's rerenderRow, not the full-list renderMessages) so nothing
   * else in the conversation — scroll position, other rows' entrance
   * animations — is disturbed by saving an edit.
   */
  function saveEdit() {
    const content = $input.val().trim();
    if (!content || !state.editingMessage) return;

    const messageId = state.editingMessage.id;
    $sendBtn.prop('disabled', true);

    Api.request({
      url: '/messages/' + messageId,
      method: 'PUT',
      data: { content: content }
    })
      .done(function (response) {
        const index = state.messages.findIndex(function (m) { return m.id === response.message.id; });
        if (index !== -1) {
          state.messages[index] = response.message;
        }
        cancelEdit(); // only on success — a failed save keeps editing context so retry doesn't lose it, same as send()'s reply context
        rerenderRow(response.message.id);
        Conversations.refresh(); // sidebar's last-message preview may show this message's (now-changed) content
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return;
        Ping.showToast(Ping.getErrorMessage(xhr, 'Unable to update message.'), 'error');
      })
      .always(function () {
        $sendBtn.prop('disabled', $input.val().trim() === '');
        $input.trigger('focus');
      });
  }

  function renderLoading() {
    $messages.empty();
    $('<div>', { class: 'chat-status' }).text('Loading messages…').appendTo($messages);
  }

  function renderError(message) {
    $messages.empty();
    $('<div>', { class: 'chat-status chat-status--error' }).text(message).appendTo($messages);
  }

  function renderMessages(scrollToBottomAfter) {
    if (state.messages.length === 0) {
      renderEmptyState();
      return;
    }

    reconcileMessages();

    if (scrollToBottomAfter) {
      scrollToBottom();
    }
  }

  /** Shown in place of the message list for a conversation with no messages
   * yet. Guarded so a poll tick that still finds zero messages doesn't keep
   * re-emptying/rebuilding this placeholder every cycle. */
  function renderEmptyState() {
    if (!$messages.children('.message-row').length && $messages.children('.chat-status').length) {
      return; // already showing it - nothing changed
    }
    $messages.empty();
    const $emptyState = $('<div>', { class: 'chat-status' });
    $('<p>').text('No messages yet.').appendTo($emptyState);
    $('<p>').text('Start the conversation.').appendTo($emptyState);
    $messages.append($emptyState);
  }

  /**
   * Reconciles state.messages into #chatMessages one message at a time
   * instead of the old empty()-then-rebuild-everything pass, which is what
   * caused every row (including unrelated ones) to flicker/replay its
   * entrance animation - and any playing <video>/<audio> preview to reset -
   * on every single poll tick, whether or not anything actually changed.
   *
   * Each message is keyed by its id (data-message-id, already used
   * elsewhere - see rerenderRow/scrollToMessage) and stamped with a
   * signature (data-sig) of its full JSON so an unchanged message can be
   * detected and left completely untouched: new id -> append a row; known
   * id whose signature changed (edit, reaction, etc.) -> replace just that
   * row in place; known id, same signature -> do nothing.
   *
   * Messages are append-only (no delete-message endpoint exists), so no
   * reordering pass is needed - new ids are simply appended in the order
   * they appear in state.messages, which the API already returns
   * chronologically.
   */
  function reconcileMessages() {
    $messages.children('.chat-status').remove(); // clear the "no messages yet" placeholder, if any

    const seenIds = {};

    state.messages.forEach(function (message) {
      seenIds[message.id] = true;
      const sig = messageSignature(message);
      const $existing = $messages.children('.message-row[data-message-id="' + message.id + '"]');

      if (!$existing.length) {
        const $row = buildStampedRow(message, sig);
        $messages.append($row);
        Ping.renderIcons($row[0]); // scoped to this one new row - see renderIcons' docstring for why
        if (state.openPickerMessageId === message.id) {
          positionPicker($row);
        }
        return;
      }

      if ($existing.attr('data-sig') === sig) return; // unchanged - leave this row's DOM completely alone

      const $row = buildStampedRow(message, sig);
      $existing.replaceWith($row);
      Ping.renderIcons($row[0]);
      if (state.openPickerMessageId === message.id) {
        positionPicker($row);
      }
    });

    // Defensive only - nothing currently deletes a message - but keeps this
    // resilient rather than leaving an orphaned row behind if that ever changes.
    $messages.children('.message-row').each(function () {
      const id = Number($(this).attr('data-message-id'));
      if (!seenIds[id]) $(this).remove();
    });
  }

  /** Every mutable field of a message (content, edited_at, reactions, ...)
   * is included by stringifying the whole object, the same
   * change-detection approach Conversations.applyConversations already
   * uses for the sidebar - so this never needs updating if the message
   * schema grows a new field later. */
  function messageSignature(message) {
    return JSON.stringify(message);
  }

  function buildStampedRow(message, sig) {
    const $row = renderMessageRow(message);
    $row.attr('data-sig', sig || messageSignature(message));
    return $row;
  }

  /**
   * The picker defaults to opening upward (see .emoji-picker CSS). For a
   * message near the top of the scrollable list, that leaves no room and
   * the picker gets clipped by .chat-messages' own overflow — invisible,
   * but still geometrically sitting under the fixed chat header, which
   * then eats its clicks. Flip it to open downward whenever it doesn't
   * fit above, the same "does it fit, else flip" check a full popover
   * library would do, just measured directly since this is the only
   * popover in the app.
   */
  function positionPicker($row) {
    const $picker = $row.find('.emoji-picker');
    if (!$picker.length || !$messages.length) return;

    const containerTop = $messages[0].getBoundingClientRect().top;
    const pickerTop = $picker[0].getBoundingClientRect().top;
    if (pickerTop < containerTop) {
      $picker.addClass('emoji-picker--below');
    }
  }

  /**
   * Re-render just one message's row in place, instead of the full
   * renderMessages() replace-everything pass. Reaction/picker interactions
   * only ever change one message, and every row carries a CSS entrance
   * animation (see .message-row) — rebuilding the whole list on every click
   * would replay that animation for every other message too. Falls back to
   * a full render if the row isn't in the DOM yet (shouldn't normally
   * happen, but keeps this safe to call from anywhere).
   */
  function rerenderRow(messageId) {
    const message = state.messages.find(function (m) { return m.id === messageId; });
    const $existingRow = $messages.find('.message-row[data-message-id="' + messageId + '"]');
    if (!message || !$existingRow.length) {
      renderMessages(false);
      return;
    }

    // Stamped with the message's current signature so the next poll tick's
    // reconcileMessages() recognizes this row as already up to date instead
    // of redundantly replacing it again with identical content.
    const $newRow = buildStampedRow(message);
    $existingRow.replaceWith($newRow);
    if (state.openPickerMessageId === messageId) {
      positionPicker($newRow);
    }
    Ping.renderIcons($newRow[0]); // scoped to this one row - see Ping.renderIcons' docstring for why
  }

  function renderMessageRow(message) {
    const sent = message.sender_id === state.currentUser.id;
    const pickerOpen = state.openPickerMessageId === message.id;

    const $row = $('<div>', {
      class: 'message-row ' + (sent ? 'message-row--sent' : 'message-row--received'),
      'data-message-id': message.id
    });

    const $wrap = $('<div>', { class: 'message-row__bubble-wrap' });

    const $bubble = $('<div>', {
      class: 'message-bubble ' + (sent ? 'message-bubble--sent' : 'message-bubble--received')
    });
    if (message.forwarded_from) {
      // A forwarded message's own content is just a snapshot of the
      // original (see backend routers/messages.py forward_message) —
      // rendering the forward block already shows that text once, so don't
      // also render message.content below it (same text, no need twice).
      // Forwarding never carries over a reply thread either (reply_to is
      // never set on a forwarded message), so this is always either/or with
      // the reply-quote branch below.
      $bubble.append(buildForwardBlock(message.forwarded_from));
    } else if (message.file) {
      // A file-share message's content is just "📎 <filename>" (see backend
      // services/file_service.py) — the file block below already conveys
      // that, so skip rendering .content as well. Uploads never set
      // reply_to either, so this is always either/or with that branch too.
      $bubble.append(buildFileOrMediaBlock(message));
    } else {
      if (message.reply_to) {
        $bubble.append(buildQuoteBlock(message.reply_to));
      }
      $('<div>', { class: 'message-bubble__content' }).text(message.content).appendTo($bubble);
    }
    // created_at (never edited_at) is always what's shown as the time — an
    // edit never changes when the message was originally sent, only whether
    // the "Edited" prefix appears (see models.Message.edited_at's docstring).
    const timeText = message.edited_at ? 'Edited · ' + formatTime(message.created_at) : formatTime(message.created_at);
    $('<div>', { class: 'message-bubble__time' }).text(timeText).appendTo($bubble);

    const $replyBtn = $('<button>', {
      type: 'button',
      class: 'message-reply-btn',
      'aria-label': 'Reply'
    });
    $('<i>', { 'data-lucide': 'reply', 'aria-hidden': 'true' }).appendTo($replyBtn);
    $replyBtn.on('click', function (e) {
      e.stopPropagation();
      closeOpenPicker();
      startReply(message);
    });

    const $forwardBtn = $('<button>', {
      type: 'button',
      class: 'message-forward-btn',
      'aria-label': 'Forward'
    });
    $('<i>', { 'data-lucide': 'forward', 'aria-hidden': 'true' }).appendTo($forwardBtn);
    $forwardBtn.on('click', function (e) {
      e.stopPropagation();
      closeOpenPicker();
      startForward(message);
    });

    const $reactBtn = $('<button>', {
      type: 'button',
      class: 'message-react-btn' + (pickerOpen ? ' is-open' : ''),
      'aria-label': 'Add reaction',
      'aria-haspopup': 'true',
      'aria-expanded': pickerOpen
    });
    $('<i>', { 'data-lucide': 'smile-plus', 'aria-hidden': 'true' }).appendTo($reactBtn);
    $reactBtn.on('click', function (e) {
      e.stopPropagation(); // don't let this bubble to the document click-outside handler below
      const previouslyOpenId = state.openPickerMessageId;
      state.openPickerMessageId = pickerOpen ? null : message.id;
      rerenderRow(message.id);
      if (previouslyOpenId !== null && previouslyOpenId !== message.id) {
        rerenderRow(previouslyOpenId); // close whichever other row's picker was open
      }
    });

    // Copy is available on every message regardless of sender — see
    // copyMessageContent's docstring for why copying message.content as-is
    // is always safe (never binary) even for a file-share message.
    const $copyBtn = $('<button>', {
      type: 'button',
      class: 'message-copy-btn',
      'aria-label': 'Copy message'
    });
    $('<i>', { 'data-lucide': 'copy', 'aria-hidden': 'true' }).appendTo($copyBtn);
    $copyBtn.on('click', function (e) {
      e.stopPropagation();
      closeOpenPicker();
      copyMessageContent(message);
    });

    $wrap.append($bubble, $replyBtn, $forwardBtn, $reactBtn, $copyBtn);

    // Edit only ever appears on the sender's own plain text messages — see
    // canEditMessage's docstring for why file/forwarded messages are excluded.
    if (canEditMessage(message)) {
      const $editBtn = $('<button>', {
        type: 'button',
        class: 'message-edit-btn',
        'aria-label': 'Edit message'
      });
      $('<i>', { 'data-lucide': 'pencil', 'aria-hidden': 'true' }).appendTo($editBtn);
      $editBtn.on('click', function (e) {
        e.stopPropagation();
        closeOpenPicker();
        startEdit(message);
      });
      $wrap.append($editBtn);
    }

    if (pickerOpen) {
      $wrap.append(buildEmojiPicker(message.id));
    }

    $row.append($wrap);

    const $reactions = renderReactionPills(message);
    if ($reactions) {
      $row.append($reactions);
    }

    return $row;
  }

  /** Compact quoted block shown above a reply's own content inside its
   * bubble. Clicking it scrolls to and highlights the original message. */
  function buildQuoteBlock(replyTo) {
    const $quote = $('<button>', { type: 'button', class: 'message-quote' });
    $('<span>', { class: 'message-quote__sender' }).text(senderDisplayName(replyTo.sender_id)).appendTo($quote);
    $('<span>', { class: 'message-quote__content' }).text(replyTo.content).appendTo($quote);
    $quote.on('click', function (e) {
      e.stopPropagation();
      scrollToMessage(replyTo.id);
    });
    return $quote;
  }

  /** "Forwarded" tag + quoted original sender/content shown inside a
   * forwarded message's own bubble — see the forwarded_from branch in
   * renderMessageRow. Not interactive (unlike buildQuoteBlock's reply
   * quote): the original message may live in a different conversation
   * that isn't open here, so there's nothing sensible to scroll to. */
  function buildForwardBlock(forwardedFrom) {
    const $block = $('<div>', { class: 'message-forward-block' });

    const $label = $('<div>', { class: 'message-forward-block__label' });
    $('<i>', { 'data-lucide': 'forward', 'aria-hidden': 'true' }).appendTo($label);
    $('<span>').text('Forwarded').appendTo($label);
    $label.appendTo($block);

    const $quote = $('<div>', { class: 'forward-quote' });
    $('<span>', { class: 'forward-quote__sender' }).text(forwardedSenderDisplayName(forwardedFrom)).appendTo($quote);
    $('<span>', { class: 'forward-quote__content' }).text(forwardedFrom.content).appendTo($quote);
    $quote.appendTo($block);

    return $block;
  }

  const PREVIEWABLE_CATEGORIES = ['image', 'video', 'audio'];

  /**
   * Dispatches a file-share message to an inline media preview
   * (image/video/audio, per the server-derived `file.category` —
   * schemas.MessageFileOut.category, never guessed client-side from the
   * filename) or the plain file card, and handles graceful fallback: a
   * category that isn't previewable, or one whose blob fetch has already
   * failed (see Media.markError), renders the plain card exactly as if it
   * were never previewable in the first place — no broken-preview UI ever
   * shown, per the task's "gracefully fall back" requirement.
   */
  function buildFileOrMediaBlock(message) {
    const file = message.file;
    if (PREVIEWABLE_CATEGORIES.indexOf(file.category) === -1) {
      return buildFileBlock(file);
    }

    const preview = Media.getPreview(file.id, function () {
      rerenderRow(message.id); // fires once the fetch settles (ready or error)
    });
    if (preview.status === 'error') {
      return buildFileBlock(file);
    }

    const $wrap = $('<div>', { class: 'message-media' });
    $wrap.append(buildMediaPreviewElement(file, preview, message.id));
    $wrap.append(buildFileBlock(file));
    return $wrap;
  }

  function buildMediaPreviewElement(file, preview, messageId) {
    if (preview.status === 'loading') {
      const $placeholder = $('<div>', { class: 'message-media__preview message-media__preview--loading' });
      $('<span>', { class: 'message-media__spinner', 'aria-hidden': 'true' }).appendTo($placeholder);
      $('<span>').text('Loading preview…').appendTo($placeholder);
      return $placeholder;
    }

    // preview.status === 'ready' from here — preview.url is a local blob:
    // URL, so the element loads instantly with no further network request.
    const $preview = $('<div>', { class: 'message-media__preview' });

    if (file.category === 'image') {
      const $img = $('<img>', {
        class: 'message-media__image',
        src: preview.url,
        alt: file.original_filename
      });
      $img.on('click', function (e) {
        e.stopPropagation();
        Media.openLightbox(preview.url, file.original_filename);
      });
      $img.on('error', function () {
        Media.markError(file.id);
        rerenderRow(messageId);
      });
      $preview.append($img);
    } else if (file.category === 'video') {
      // preload:'metadata' (not 'auto') since preview.url is already a
      // fully-fetched local blob — nothing left to eagerly buffer.
      const $video = $('<video>', { class: 'message-media__video', src: preview.url, preload: 'metadata' })
        .prop('controls', true); // .prop, not the attrs object above — controls/autoplay/muted are IDL boolean properties, not string attributes
      $video.on('click', function (e) {
        e.stopPropagation(); // don't let a control click bubble into the row's reply/react handlers
      });
      $video.on('error', function () {
        Media.markError(file.id);
        rerenderRow(messageId);
      });
      $preview.append($video);
    } else {
      const $audio = $('<audio>', { class: 'message-media__audio', src: preview.url, preload: 'metadata' })
        .prop('controls', true);
      $audio.on('click', function (e) {
        e.stopPropagation();
      });
      $audio.on('error', function () {
        Media.markError(file.id);
        rerenderRow(messageId);
      });
      $preview.append($audio);
    }

    return $preview;
  }

  /** File-share block shown inside a file message's own bubble (see the
   * message.file branch in renderMessageRow): icon (by MIME type), name,
   * size, and a download button that fetches the file as a Blob (rather
   * than a plain <a href>) so the request can carry the Authorization
   * header the download endpoint requires. Also what a previewable
   * image/video/audio message renders BELOW its inline preview (see
   * buildFileOrMediaBlock) — same metadata + download either way. */
  function buildFileBlock(file) {
    const $block = $('<div>', { class: 'message-file' });

    const $icon = $('<div>', { class: 'message-file__icon' });
    $('<i>', { 'data-lucide': fileIconName(file.mime_type), 'aria-hidden': 'true' }).appendTo($icon);
    $icon.appendTo($block);

    const $body = $('<div>', { class: 'message-file__body' });
    $('<span>', { class: 'message-file__name' }).text(file.original_filename).appendTo($body);
    $('<span>', { class: 'message-file__meta' }).text(formatFileSize(file.file_size)).appendTo($body);
    $body.appendTo($block);

    const $downloadBtn = $('<button>', {
      type: 'button',
      class: 'message-file__download',
      'aria-label': 'Download ' + file.original_filename,
      title: 'Download'
    });
    $('<i>', { 'data-lucide': 'download', 'aria-hidden': 'true' }).appendTo($downloadBtn);
    $downloadBtn.on('click', function (e) {
      e.stopPropagation();
      downloadFile(file.id, file.original_filename);
    });
    $downloadBtn.appendTo($block);

    return $block;
  }

  function fileIconName(mimeType) {
    if (!mimeType) return 'file';
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType.startsWith('audio/')) return 'music';
    if (mimeType.startsWith('text/')) return 'file-text';
    if (mimeType === 'application/pdf') return 'file-text';
    if (mimeType.indexOf('zip') !== -1 || mimeType.indexOf('compressed') !== -1 || mimeType.indexOf('archive') !== -1) {
      return 'file-archive';
    }
    return 'file';
  }

  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unitIndex = -1;
    do {
      value /= 1024;
      unitIndex++;
    } while (value >= 1024 && unitIndex < units.length - 1);
    return value.toFixed(value < 10 ? 1 : 0) + ' ' + units[unitIndex];
  }

  /**
   * Downloads a file via an authenticated fetch (a plain <a href> can't
   * carry the Authorization header the endpoint requires) and hands the
   * browser the result as a Blob so it saves under the original filename
   * instead of navigating to it. Goes through Media.fetchAsBlob — the same
   * helper inline previews use — rather than duplicating the fetch, though
   * this always issues its own request rather than reading Media's cache:
   * a cached preview blob URL is fine to *display*, but re-fetching keeps
   * download decoupled from preview-cache bookkeeping (a file with no
   * inline preview, e.g. a PDF, still downloads with zero cache involved).
   */
  function downloadFile(fileId, filename) {
    Media.fetchAsBlob(fileId)
      .then(function (blob) {
        const url = URL.createObjectURL(blob);
        const $link = $('<a>', { href: url, download: filename }).css('display', 'none');
        $('body').append($link);
        $link[0].click();
        $link.remove();
        URL.revokeObjectURL(url);
      })
      .catch(function () {
        Ping.showToast('Unable to download file.', 'error');
      });
  }

  function buildEmojiPicker(messageId) {
    const $picker = $('<div>', { class: 'emoji-picker', role: 'menu' });
    REACTION_EMOJIS.forEach(function (emoji) {
      $('<button>', {
        type: 'button',
        class: 'emoji-picker__btn',
        role: 'menuitem',
        'aria-label': 'React with ' + emoji
      })
        .text(emoji)
        .on('click', function () {
          toggleReaction(messageId, emoji);
        })
        .appendTo($picker);
    });
    return $picker;
  }

  function renderReactionPills(message) {
    const reactions = message.reactions || [];
    if (!reactions.length) return null;

    const $container = $('<div>', { class: 'message-reactions' });
    reactions.forEach(function (reaction) {
      const $pill = $('<button>', {
        type: 'button',
        class: 'reaction-pill' + (reaction.reacted_by_me ? ' reaction-pill--mine' : ''),
        title: reactorsLabel(reaction)
      });
      $('<span>', { class: 'reaction-pill__emoji' }).text(reaction.emoji).appendTo($pill);
      $('<span>', { class: 'reaction-pill__count' }).text(reaction.count).appendTo($pill);
      $pill.on('click', function () {
        toggleReaction(message.id, reaction.emoji);
      });
      $container.append($pill);
    });
    return $container;
  }

  function reactorsLabel(reaction) {
    return reaction.users
      .map(function (user) {
        return user.id === state.currentUser.id ? 'You' : user.name;
      })
      .join(', ');
  }

  /**
   * Toggle the current user's reaction of `emoji` on a message: updates
   * state.messages (and re-renders) immediately so the UI feels instant,
   * then confirms with the server and reconciles — or rolls back on failure.
   */
  function toggleReaction(messageId, emoji) {
    const message = state.messages.find(function (m) { return m.id === messageId; });
    if (!message) return;

    const existing = (message.reactions || []).find(function (r) { return r.emoji === emoji; });
    const removing = !!(existing && existing.reacted_by_me);

    state.openPickerMessageId = null;
    applyOptimisticReaction(message, emoji, !removing);
    rerenderRow(messageId);

    const request = removing
      ? Api.request({
          url: '/messages/' + messageId + '/reactions/' + encodeURIComponent(emoji),
          method: 'DELETE'
        })
      : Api.request({
          url: '/messages/' + messageId + '/reactions',
          method: 'POST',
          data: { emoji: emoji }
        });

    request
      .done(function (response) {
        message.reactions = response.reactions;
        rerenderRow(messageId);
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return;
        applyOptimisticReaction(message, emoji, removing); // undo the optimistic change
        rerenderRow(messageId);
        Ping.showToast(Ping.getErrorMessage(xhr, 'Unable to update reaction.'), 'error');
      });
  }

  function applyOptimisticReaction(message, emoji, adding) {
    const reactions = (message.reactions || []).slice();
    const index = reactions.findIndex(function (r) { return r.emoji === emoji; });
    const me = { id: state.currentUser.id, name: state.currentUser.name };

    if (adding) {
      if (index === -1) {
        reactions.push({ emoji: emoji, count: 1, users: [me], reacted_by_me: true });
      } else if (!reactions[index].reacted_by_me) {
        const r = reactions[index];
        reactions[index] = { emoji: emoji, count: r.count + 1, users: r.users.concat([me]), reacted_by_me: true };
      }
    } else if (index !== -1 && reactions[index].reacted_by_me) {
      const r = reactions[index];
      const remainingUsers = r.users.filter(function (u) { return u.id !== state.currentUser.id; });
      if (remainingUsers.length === 0) {
        reactions.splice(index, 1);
      } else {
        reactions[index] = { emoji: emoji, count: remainingUsers.length, users: remainingUsers, reacted_by_me: false };
      }
    }

    message.reactions = reactions;
  }

  function scrollToBottom() {
    $messages.scrollTop($messages[0].scrollHeight);
  }

  function formatTime(isoString) {
    const date = new Date(isoString);
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  function startPolling() {
    stopPolling();
    state.pollHandle = setInterval(function () {
      fetchAndRender(false);
    }, POLL_INTERVAL_MS);
  }

  function stopPolling() {
    if (state.pollHandle) {
      clearInterval(state.pollHandle);
      state.pollHandle = null;
    }
  }

  return {
    init: init,
    openConversation: openConversation,
    closeConversation: closeConversation,
    handleForwarded: handleForwarded,
    handleFileUploaded: handleFileUploaded,
    getConversationId: getConversationId,
    getOtherUser: getOtherUser,
    stopPolling: stopPolling
  };
})(jQuery);
