/**
 * Entry point: route to the dashboard if a session already exists,
 * otherwise to login.
 */
$(function () {
  window.location.href = Ping.isAuthenticated() ? 'dashboard/index.html' : 'auth/login.html';
});
