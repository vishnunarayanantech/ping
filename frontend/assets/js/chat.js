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
    if (message.reply_to) {
      $bubble.append(buildQuoteBlock(message.reply_to));
    }
    $('<div>', { class: 'message-bubble__content' }).text(message.content).appendTo($bubble);
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

    $wrap.append($bubble, $replyBtn, $reactBtn);

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
    stopPolling: stopPolling
  };
})(jQuery);
