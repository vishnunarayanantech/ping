/**
 * Forward-message modal: pick one or more conversations, preview the
 * original sender/content, and forward on confirm. Self-contained — owns
 * the modal's DOM (see the markup in dashboard/index.html). chat.js calls
 * Forward.open(message, senderLabel) from a message row's Forward action;
 * dashboard.js calls Forward.init() once at startup.
 *
 * Reuses Conversations.getAll() for the picker list rather than issuing its
 * own fetch — that list is already kept current by Conversations' own poll.
 */
const Forward = (function ($) {
  'use strict';

  const state = {
    message: null,
    selectedConversationIds: new Set()
  };

  let $overlay, $list, $previewSender, $previewContent, $confirmBtn;

  function init() {
    $overlay = $('#forwardModalOverlay');
    $list = $('#forwardConversationList');
    $previewSender = $('#forwardPreviewSender');
    $previewContent = $('#forwardPreviewContent');
    $confirmBtn = $('#forwardConfirmBtn');

    $('#forwardCancelBtn').on('click', close);
    $('#forwardModalClose').on('click', close);

    // Click on the dimmed backdrop (not the modal panel itself) closes it,
    // same convention as the emoji picker's click-outside-to-close.
    $overlay.on('click', function (e) {
      if (e.target === $overlay[0]) close();
    });

    $(document).on('keydown', function (e) {
      if (e.key === 'Escape' && !$overlay.prop('hidden')) close();
    });

    $confirmBtn.on('click', confirmForward);
  }

  /**
   * Open the picker for `message`. `senderLabel` is the already-resolved
   * display name ("You" or the other participant's name) for the message's
   * sender — chat.js computes this since it alone knows the two-party
   * context of the conversation the message is being forwarded FROM.
   */
  function open(message, senderLabel) {
    state.message = message;
    state.selectedConversationIds = new Set();

    $previewSender.text(senderLabel);
    $previewContent.text(message.content);

    renderConversationList();
    updateConfirmState();

    $overlay.prop('hidden', false);
    Ping.renderIcons();
  }

  function close() {
    $overlay.prop('hidden', true);
    state.message = null;
    state.selectedConversationIds = new Set();
  }

  function renderConversationList() {
    $list.empty();
    const conversations = Conversations.getAll();

    if (!conversations.length) {
      $('<div>', { class: 'forward-modal__empty' }).text('No conversations to forward to yet.').appendTo($list);
      return;
    }

    conversations.forEach(function (conversation) {
      const otherUser = conversation.other_user;
      const isSelected = state.selectedConversationIds.has(conversation.id);

      const $item = $('<button>', {
        type: 'button',
        class: 'forward-conversation-item' + (isSelected ? ' is-selected' : ''),
        'data-conversation-id': conversation.id,
        'aria-pressed': isSelected
      });

      const $avatar = $('<span>', { class: 'avatar avatar--sm' }).appendTo($item);
      Avatars.apply($avatar, otherUser.name, otherUser.avatar_url);
      $('<span>', { class: 'forward-conversation-item__name' }).text(otherUser.name).appendTo($item);

      const $check = $('<span>', { class: 'forward-conversation-item__check', 'aria-hidden': 'true' });
      $('<i>', { 'data-lucide': 'check' }).appendTo($check);
      $check.appendTo($item);

      $item.on('click', function () {
        toggleConversation(conversation.id, $item);
      });

      $list.append($item);
    });

    Ping.renderIcons();
  }

  function toggleConversation(conversationId, $item) {
    if (state.selectedConversationIds.has(conversationId)) {
      state.selectedConversationIds.delete(conversationId);
      $item.removeClass('is-selected').attr('aria-pressed', 'false');
    } else {
      state.selectedConversationIds.add(conversationId);
      $item.addClass('is-selected').attr('aria-pressed', 'true');
    }
    updateConfirmState();
  }

  function updateConfirmState() {
    $confirmBtn.prop('disabled', state.selectedConversationIds.size === 0);
  }

  function confirmForward() {
    if (!state.message || state.selectedConversationIds.size === 0) return;

    const message = state.message;
    const conversationIds = Array.from(state.selectedConversationIds);
    $confirmBtn.prop('disabled', true);

    Api.request({
      url: '/messages/' + message.id + '/forward',
      method: 'POST',
      data: { conversation_ids: conversationIds }
    })
      .done(function (response) {
        const count = response.messages.length;
        Ping.showToast(count === 1 ? 'Message forwarded.' : 'Message forwarded to ' + count + ' conversations.', 'success');
        close();
        Conversations.refresh();
        Chat.handleForwarded(response.messages);
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return;
        Ping.showToast(Ping.getErrorMessage(xhr, 'Unable to forward message.'), 'error');
        $confirmBtn.prop('disabled', false);
      });
  }

  return { init: init, open: open };
})(jQuery);
