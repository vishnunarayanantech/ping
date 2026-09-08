/**
 * Recent-conversations sidebar: load + render the list, keep track of which
 * one is active, and get-or-create a conversation when a search result is
 * clicked. Self-contained — owns the conversation-list DOM. dashboard.js
 * calls init() once with a callback for "a conversation should open now."
 */
const Conversations = (function ($) {
  'use strict';

  const state = {
    currentUser: null,
    conversations: [],
    activeConversationId: null,
    onOpenConversation: null
  };

  let $list;

  function init(currentUser, onOpenConversation) {
    state.currentUser = currentUser;
    state.onOpenConversation = onOpenConversation;
    $list = $('#conversationList');
    load();
  }

  function load() {
    renderSkeleton();

    Api.request({ url: '/conversations' })
      .done(function (response) {
        state.conversations = response.conversations;
        render();
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return; // api.js is already redirecting to login
        renderError(Ping.getErrorMessage(xhr, 'Unable to load conversations.'));
      });
  }

  /** Re-fetch and re-render — called after sending a message so the sidebar
   * reflects the new order/preview without a full page reload. */
  function refresh() {
    Api.request({ url: '/conversations' })
      .done(function (response) {
        state.conversations = response.conversations;
        render();
      })
      .fail(function () {
        // Silent — a failed background refresh shouldn't disrupt an open chat.
      });
  }

  /** Get-or-create a direct conversation with `user`, then open it. */
  function openWithUser(user) {
    Api.request({ url: '/conversations/direct/' + user.id, method: 'POST' })
      .done(function (response) {
        setActive(response.conversation.id);
        if (state.onOpenConversation) {
          state.onOpenConversation(response.conversation.id, user);
        }
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return;
        Ping.showToast(Ping.getErrorMessage(xhr, 'Unable to start conversation.'), 'error');
      });
  }

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
      const $item = $('<button>', {
        type: 'button',
        class: 'conversation-item',
        'data-conversation-id': conversation.id
      });

      $('<span>', { class: 'avatar avatar--sm' }).text(Ping.initials(otherUser.name)).appendTo($item);

      const $info = $('<span>', { class: 'conversation-item__info' });
      const $top = $('<span>', { class: 'conversation-item__top' });
      $('<span>', { class: 'conversation-item__name' }).text(otherUser.name).appendTo($top);
      $('<span>', { class: 'conversation-item__time' })
        .text(conversation.last_message ? formatRelativeTime(conversation.last_message.created_at) : '')
        .appendTo($top);
      $top.appendTo($info);

      $('<span>', { class: 'conversation-item__preview' })
        .text(conversation.last_message ? conversation.last_message.content : 'No messages yet')
        .appendTo($info);

      $info.appendTo($item);

      $item.toggleClass('is-active', conversation.id === state.activeConversationId);

      $item.on('click', function () {
        setActive(conversation.id);
        if (state.onOpenConversation) {
          state.onOpenConversation(conversation.id, otherUser);
        }
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

  return {
    init: init,
    refresh: refresh,
    openWithUser: openWithUser,
    setActive: setActive
  };
})(jQuery);
