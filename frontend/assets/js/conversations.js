/**
 * Recent-conversations sidebar: load + render the list, keep track of which
 * one is active, get-or-create a conversation when a search result is
 * clicked, and poll the backend so unread counts / ordering / previews stay
 * current without a full page reload. Self-contained — owns the
 * conversation-list DOM. dashboard.js calls init() once with a callback for
 * "a conversation should open now."
 *
 * No WebSockets yet: polling is the only way this module learns about
 * activity from other users. markRead()/refresh() are written as small,
 * named operations independent of *how* they get triggered (a poll tick
 * today, a WebSocket event later) so that swap only ever touches
 * startPolling()/stopPolling() here.
 */
const Conversations = (function ($) {
  'use strict';

  const state = {
    currentUser: null,
    conversations: [],
    activeConversationId: null,
    onOpenConversation: null,
    pollHandle: null,
    pollInFlight: false
  };

  let $list;

  function init(currentUser, onOpenConversation) {
    state.currentUser = currentUser;
    state.onOpenConversation = onOpenConversation;
    $list = $('#conversationList');
    load();
    startPolling();
  }

  function load() {
    renderSkeleton();
    fetchConversations(true);
  }

  /** Re-fetch and re-render — called after sending a message so the sidebar
   * reflects the new order/preview without waiting for the next poll tick. */
  function refresh() {
    fetchConversations(false);
  }

  function fetchConversations(isInitialLoad) {
    if (state.pollInFlight) return; // never let requests overlap
    state.pollInFlight = true;

    return Api.request({ url: '/conversations' })
      .done(function (response) {
        applyConversations(response.conversations);
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return; // api.js is already redirecting to login
        if (isInitialLoad) {
          renderError(Ping.getErrorMessage(xhr, 'Unable to load conversations.'));
        }
        // Silent on background poll failures — keep showing the last known
        // state rather than disrupting whatever the user is doing.
      })
      .always(function () {
        state.pollInFlight = false;
      });
  }

  /**
   * Apply a fresh /conversations response. Skips re-rendering entirely when
   * nothing changed, so a poll tick with no news doesn't touch the DOM.
   */
  function applyConversations(freshConversations) {
    // RULE 1 safety net: the conversation the user is actively looking at
    // should never show as unread. chat.js is what actually marks it read
    // (as soon as it notices a new message in the open conversation), but
    // that runs on its own poll timer — if this sidebar poll ever samples
    // the backend in the brief window before chat.js catches up, clear it
    // here too instead of flashing a badge on the conversation they're
    // already viewing.
    freshConversations.forEach(function (conversation) {
      if (conversation.id === state.activeConversationId && conversation.unread_count > 0) {
        conversation.unread_count = 0;
        sendMarkRead(conversation.id);
      }
    });

    const changed = JSON.stringify(freshConversations) !== JSON.stringify(state.conversations);
    state.conversations = freshConversations;
    if (changed) render();
  }

  /** Fire-and-forget mark-as-read — used for the RULE 1 safety net above,
   * where the backend just needs to catch up eventually. */
  function sendMarkRead(conversationId) {
    Api.request({ url: '/conversations/' + conversationId + '/read', method: 'POST' });
  }

  /**
   * Mark a conversation read and only clear its badge once the backend
   * confirms it (RULE 3 — a click alone must never clear the unread
   * indicator; only an actually-successful read does). Called by chat.js
   * once it has successfully loaded messages for the open conversation.
   */
  function markRead(conversationId) {
    return Api.request({ url: '/conversations/' + conversationId + '/read', method: 'POST' })
      .done(function () {
        const conversation = state.conversations.find(function (c) {
          return c.id === conversationId;
        });
        if (conversation && conversation.unread_count !== 0) {
          conversation.unread_count = 0;
          render();
        }
      });
  }

  /** Get-or-create a direct conversation with `user`, then open it. */
  function openWithUser(user) {
    Api.request({ url: '/conversations/direct/' + user.id, method: 'POST' })
      .done(function (response) {
        openConversation(response.conversation.id, user);
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return;
        Ping.showToast(Ping.getErrorMessage(xhr, 'Unable to start conversation.'), 'error');
      });
  }

  function openConversation(conversationId, otherUser) {
    setActive(conversationId);
    if (state.onOpenConversation) {
      state.onOpenConversation(conversationId, otherUser);
    }
  }

  /** Just the "which sidebar item looks selected" state — independent of
   * unread status, which only chat.js's confirmed markRead() clears. */
  function setActive(conversationId) {
    state.activeConversationId = conversationId;
    $list.find('.conversation-item').each(function () {
      const $item = $(this);
      $item.toggleClass('is-active', Number($item.data('conversationId')) === conversationId);
    });
  }

  function renderSkeleton() {
    $list.empty();
    for (let i = 0; i < 3; i++) {
      const $row = $('<div>', { class: 'conversation-skeleton-row' });
      $('<span>', { class: 'conversation-skeleton-row__avatar' }).appendTo($row);
      const $lines = $('<span>', { class: 'conversation-skeleton-row__lines' });
      $('<span>', { class: 'conversation-skeleton-row__line' }).appendTo($lines);
      $('<span>', { class: 'conversation-skeleton-row__line' }).appendTo($lines);
      $lines.appendTo($row);
      $list.append($row);
    }
  }

  function renderError(message) {
    $list.empty();
    $('<div>', { class: 'conversation-list__empty' }).text(message).appendTo($list);
  }

  function formatUnreadCount(count) {
    return count > 99 ? '99+' : String(count);
  }

  function render() {
    $list.empty();

    if (state.conversations.length === 0) {
      const $empty = $('<div>', { class: 'conversation-list__empty' });
      $('<p>').text('No conversations yet.').appendTo($empty);
      $('<p>').text('Search for a colleague to start chatting.').appendTo($empty);
      $list.append($empty);
      return;
    }

    state.conversations.forEach(function (conversation) {
      const otherUser = conversation.other_user;
      const isUnread = conversation.unread_count > 0;

      const $item = $('<button>', {
        type: 'button',
        class: 'conversation-item' + (isUnread ? ' conversation-item--unread' : ''),
        'data-conversation-id': conversation.id
      });

      const $avatar = $('<span>', { class: 'avatar avatar--sm' }).appendTo($item);
      Avatars.apply($avatar, otherUser.name, otherUser.avatar_url);

      const $info = $('<span>', { class: 'conversation-item__info' });
      const $top = $('<span>', { class: 'conversation-item__top' });
      $('<span>', { class: 'conversation-item__name' }).text(otherUser.name).appendTo($top);

      const $meta = $('<span>', { class: 'conversation-item__meta' });
      $('<span>', { class: 'conversation-item__time' })
        .text(conversation.last_message ? formatRelativeTime(conversation.last_message.created_at) : '')
        .appendTo($meta);
      if (isUnread) {
        $('<span>', { class: 'unread-badge' }).text(formatUnreadCount(conversation.unread_count)).appendTo($meta);
      }
      $meta.appendTo($top);

      $top.appendTo($info);

      $('<span>', { class: 'conversation-item__preview' })
        .text(conversation.last_message ? conversation.last_message.content : 'No messages yet')
        .appendTo($info);

      $info.appendTo($item);

      $item.toggleClass('is-active', conversation.id === state.activeConversationId);

      $item.on('click', function () {
        openConversation(conversation.id, otherUser);
      });

      $list.append($item);
    });
  }

  /**
   * Lightweight, dependency-free relative-time formatting:
   * today -> "10:30 AM", yesterday -> "Yesterday", within a week -> weekday
   * name, older -> "Sep 2".
   */
  function formatRelativeTime(isoString) {
    const date = new Date(isoString);
    const now = new Date();

    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const dayDiff = Math.round((startOfToday - startOfDate) / 86400000);

    if (dayDiff === 0) {
      return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    if (dayDiff === 1) {
      return 'Yesterday';
    }
    if (dayDiff > 1 && dayDiff < 7) {
      return date.toLocaleDateString([], { weekday: 'long' });
    }
    return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function startPolling() {
    stopPolling();
    state.pollHandle = setInterval(function () {
      fetchConversations(false);
    }, CONVERSATION_POLL_INTERVAL);
  }

  function stopPolling() {
    if (state.pollHandle) {
      clearInterval(state.pollHandle);
      state.pollHandle = null;
    }
  }

  /** The current sidebar list, e.g. for the forward-message modal's
   * conversation picker — reuses what's already loaded/polled here instead
   * of issuing a separate fetch. */
  function getAll() {
    return state.conversations;
  }

  return {
    init: init,
    refresh: refresh,
    openWithUser: openWithUser,
    setActive: setActive,
    markRead: markRead,
    getAll: getAll,
    stopPolling: stopPolling
  };
})(jQuery);
