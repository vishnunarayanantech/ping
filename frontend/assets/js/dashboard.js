/**
 * Main application shell: auth guard, sidebar user info, logout, and
 * wiring the Conversations (sidebar), Users (search), and Chat (open
 * conversation) modules together.
 *
 * The auth guard here is a UI convenience, not a security boundary — every
 * actual protected action goes through api.js, which attaches the JWT and
 * every backend endpoint independently verifies it (see security.py).
 */
$(function () {
  if (!Ping.isAuthenticated()) {
    window.location.href = '../auth/login.html';
    return;
  }

  const user = Ping.getSession();

  $('#sidebarUserInitials').text(Ping.initials(user.name));
  $('#sidebarUserName').text(user.name);
  $('#sidebarUserEmail').text(user.email);

  Chat.init(user);
  Forward.init();
  Upload.init();
  Media.init();

  // Both the recent-conversations list and user search ultimately just need
  // to open a conversation — they share this one callback.
  function openConversation(conversationId, otherUser) {
    Chat.openConversation(conversationId, otherUser);
  }

  Conversations.init(user, openConversation);

  Users.init($('#userSearchInput'), $('#searchResults'), function (selectedUser) {
    $('#userSearchInput').val('');
    Conversations.openWithUser(selectedUser);
  });

  $('#logoutBtn').on('click', function () {
    Chat.stopPolling();
    Conversations.stopPolling();
    Ping.clearSession();
    window.location.href = '../auth/login.html';
  });
});
