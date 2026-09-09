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

  const state = {
    currentUser: null,
    conversationId: null,
    otherUser: null,
    messages: [],
    lastMarkedMessageId: null,
    pollHandle: null
  };

  let $shell, $empty, $conversation, $headerAvatar, $headerName,
    $messages, $form, $input, $sendBtn;

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

    $input.on('input', function () {
      $sendBtn.prop('disabled', $input.val().trim() === '');
    });

    $form.on('submit', function (e) {
      e.preventDefault();
      send();
    });

    $('#chatBackBtn').on('click', closeConversation);
  }

  function openConversation(conversationId, otherUser) {
    stopPolling();
    state.conversationId = conversationId;
    state.otherUser = otherUser;
    state.messages = [];
    state.lastMarkedMessageId = null;

    $shell.addClass('app-shell--conversation-open');
    $empty.prop('hidden', true);
    $conversation.prop('hidden', false);

    $headerAvatar.text(Ping.initials(otherUser.name));
    $headerName.text(otherUser.name);

    $input.val('');
    $sendBtn.prop('disabled', true);

    fetchAndRender(true);
    startPolling();

    $input.trigger('focus');
  }

  function closeConversation() {
    stopPolling();
    state.conversationId = null;
    state.otherUser = null;
    state.lastMarkedMessageId = null;
    $shell.removeClass('app-shell--conversation-open');
    $conversation.prop('hidden', true);
    $empty.prop('hidden', false);
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

    $sendBtn.prop('disabled', true);

    Api.request({
      url: '/messages',
      method: 'POST',
      data: { conversation_id: state.conversationId, content: content }
    })
      .done(function (response) {
        state.messages.push(response.message);
        state.lastMarkedMessageId = response.message.id; // our own message never needs marking read
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
      const sent = message.sender_id === state.currentUser.id;
      const $bubble = $('<div>', {
        class: 'message-bubble ' + (sent ? 'message-bubble--sent' : 'message-bubble--received')
      });
      $('<div>', { class: 'message-bubble__content' }).text(message.content).appendTo($bubble);
      $('<div>', { class: 'message-bubble__time' }).text(formatTime(message.created_at)).appendTo($bubble);
      $messages.append($bubble);
    });

    if (scrollToBottomAfter) {
      scrollToBottom();
    }
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
