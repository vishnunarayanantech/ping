/**
 * Conversation state, message rendering, sending, and lightweight polling.
 * Owns the chat area's DOM; dashboard.js just calls Chat.init() once, then
 * Chat.openConversation(conversationId, otherUser) whenever a sidebar item
 * or search result resolves to a conversation.
 *
 * No WebSockets yet — while a conversation is open, we just re-fetch and
 * fully replace the message list every POLL_INTERVAL_MS. Replacing (rather
 * than appending) means a message we just sent can never show up twice
 * once the next poll tick confirms it from the server. startPolling() /
 * stopPolling() are the seam a future WebSocket connection would plug into.
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
    // Which message (if any) currently has its emoji picker open — a render
    // flag, not fetched state, so it survives renderMessages() being called
    // again (poll ticks, sends, reactions) instead of getting wiped along
    // with the rest of the message DOM every time.
    openPickerMessageId: null,
    // The message (a full entry from state.messages) the composer is
    // currently replying to, or null. Also just a render flag — cleared on
    // send, cancel, or switching/closing conversations.
    replyTo: null
  };

  let $shell, $empty, $conversation, $headerAvatar, $headerName,
    $messages, $form, $input, $sendBtn,
    $replyPreview, $replyPreviewSender, $replyPreviewContent;

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

    $input.on('input', function () {
      $sendBtn.prop('disabled', $input.val().trim() === '');
    });

    $form.on('submit', function (e) {
      e.preventDefault();
      send();
    });

    $('#chatBackBtn').on('click', closeConversation);

    $('#replyPreviewClose').on('click', cancelReply);

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

    $shell.addClass('app-shell--conversation-open');
    $empty.prop('hidden', true);
    $conversation.prop('hidden', false);

    $headerAvatar.text(Ping.initials(otherUser.name));
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
    renderMessages(true);
  }

  /** The conversation currently open, or null — upload.js needs this to
   * know which conversation a file picked from the composer belongs to. */
  function getConversationId() {
    return state.conversationId;
  }

  /** Set the message the composer is replying to and show its preview above
   * the input. Called from the row-hover reply button. */
  function startReply(message) {
    state.replyTo = message;
    renderReplyPreview();
    $input.trigger('focus');
  }

  function cancelReply() {
    if (state.replyTo === null) return;
    state.replyTo = null;
    renderReplyPreview();
  }

  function renderReplyPreview() {
    if (!state.replyTo) {
      $replyPreview.prop('hidden', true);
      return;
    }
    $replyPreviewSender.text(senderDisplayName(state.replyTo.sender_id));
    $replyPreviewContent.text(state.replyTo.content);
    $replyPreview.prop('hidden', false);
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

  function renderLoading() {
    $messages.empty();
    $('<div>', { class: 'chat-status' }).text('Loading messages…').appendTo($messages);
  }

  function renderError(message) {
    $messages.empty();
    $('<div>', { class: 'chat-status chat-status--error' }).text(message).appendTo($messages);
  }

  function renderMessages(scrollToBottomAfter) {
    $messages.empty();

    if (state.messages.length === 0) {
      const $emptyState = $('<div>', { class: 'chat-status' });
      $('<p>').text('No messages yet.').appendTo($emptyState);
      $('<p>').text('Start the conversation.').appendTo($emptyState);
      $messages.append($emptyState);
      return;
    }

    state.messages.forEach(function (message) {
      const $row = renderMessageRow(message);
      $messages.append($row);
      if (state.openPickerMessageId === message.id) {
        positionPicker($row);
      }
    });

    Ping.renderIcons();

    if (scrollToBottomAfter) {
      scrollToBottom();
    }
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

    const $newRow = renderMessageRow(message);
    $existingRow.replaceWith($newRow);
    if (state.openPickerMessageId === messageId) {
      positionPicker($newRow);
    }
    Ping.renderIcons();
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
    $('<div>', { class: 'message-bubble__time' }).text(formatTime(message.created_at)).appendTo($bubble);

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

    $wrap.append($bubble, $replyBtn, $forwardBtn, $reactBtn);

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
    stopPolling: stopPolling
  };
})(jQuery);
