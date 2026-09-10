/**
 * ping — shared utilities used by every page.
 * Exposes a single `Ping` namespace so page scripts avoid globals
 * and duplicated logic (branding, theme, toasts, validation, toggles).
 */
const Ping = (function ($) {
  'use strict';

  const THEME_KEY = 'ping-theme';
  const SESSION_KEY = 'ping_user';
  const TOKEN_KEY = 'ping_token';

  /**
   * Fill in [data-app-name] / [data-app-tagline] elements from config,
   * and rebuild <title> from each page's data-page-title + the app name
   * so a rebrand only ever requires editing config.js.
   */
  function applyBranding() {
    $('[data-app-name]').text(APP_CONFIG.appName);
    $('[data-app-tagline]').text(APP_CONFIG.tagline);

    const pageTitle = document.body.getAttribute('data-page-title');
    document.title = pageTitle ? pageTitle + ' — ' + APP_CONFIG.appName : APP_CONFIG.appName;
  }

  /**
   * Render Lucide icon placeholders (`<i data-lucide="...">`) into inline
   * SVGs. lucide.createIcons() matches every element carrying the
   * data-lucide attribute - which its own output SVGs keep - so an
   * unscoped call re-creates *every* icon already on the page, not just
   * new ones. Pass a specific DOM element as `root` (e.g. a single
   * newly-built message row) to limit the pass to icons inside it; omit it
   * for the normal whole-page cases (initial render, toasts, modals).
   */
  function renderIcons(root) {
    if (window.lucide) {
      window.lucide.createIcons({ root: root });
    }
  }

  /** Apply saved theme (or default) and wire up any .theme-toggle button. */
  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'light';
    document.documentElement.setAttribute('data-theme', saved);

    $('.theme-toggle').on('click', function () {
      const current = document.documentElement.getAttribute('data-theme');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem(THEME_KEY, next);
    });
  }

  /** Basic, frontend-only email format check. */
  function isValidEmail(value) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  }

  /**
   * Show or hide a field's inline error message.
   * @param {jQuery} $field - the .field wrapper containing input + error node
   * @param {string} [message] - error text; omit to clear the error
   */
  function setFieldError($field, message) {
    const $error = $field.find('.field__error');
    const $input = $field.find('.input');

    if (message) {
      $error.empty();
      $('<i>', { 'data-lucide': 'alert-circle', 'aria-hidden': 'true' }).appendTo($error);
      $('<span>').text(message).appendTo($error);
      $error.addClass('is-visible');
      $input.attr('aria-invalid', 'true');
      renderIcons();
    } else {
      $error.removeClass('is-visible').empty();
      $input.attr('aria-invalid', 'false');
    }
  }

  /**
   * Wire up every .password-toggle button on the page to flip its
   * paired input (referenced via data-target) between password/text.
   */
  function initPasswordToggles() {
    $('.password-toggle').on('click', function () {
      const $btn = $(this);
      const $input = $($btn.data('target'));
      const revealing = $input.attr('type') === 'password';

      $input.attr('type', revealing ? 'text' : 'password');
      $btn.toggleClass('is-visible', revealing);
      $btn.attr('aria-label', revealing ? 'Hide password' : 'Show password');
    });
  }

  /**
   * Show a transient toast notification.
   * @param {string} message
   * @param {'success'|'error'} [type]
   */
  function showToast(message, type) {
    type = type || 'success';
    const $container = $('#toastContainer');
    if (!$container.length) return;

    const iconName = type === 'success' ? 'check-circle' : 'alert-circle';
    const $toast = $('<div>', { class: 'toast toast--' + type, role: 'status' });
    $('<i>', { 'data-lucide': iconName, 'aria-hidden': 'true' }).appendTo($toast);
    $('<span>').text(message).appendTo($toast);

    $container.append($toast);
    renderIcons();

    requestAnimationFrame(function () {
      $toast.addClass('toast--visible');
    });

    setTimeout(function () {
      $toast.removeClass('toast--visible');
      setTimeout(function () {
        $toast.remove();
      }, 250);
    }, 3200);
  }

  /** Toggle a button's loading state (spinner replaces label, disabled). */
  function setButtonLoading($btn, isLoading) {
    $btn.toggleClass('is-loading', isLoading).prop('disabled', isLoading);
    $btn.attr('aria-busy', isLoading ? 'true' : 'false');
  }

  /**
   * Show a form-level error banner (for backend/network errors that
   * aren't tied to one specific field, e.g. "Invalid email or password").
   */
  function showFormAlert($alert, message) {
    if (!$alert || !$alert.length) return;
    $alert.empty();
    $('<i>', { 'data-lucide': 'alert-circle', 'aria-hidden': 'true' }).appendTo($alert);
    $('<span>').text(message).appendTo($alert);
    $alert.addClass('is-visible');
    renderIcons();
  }

  function hideFormAlert($alert) {
    if (!$alert || !$alert.length) return;
    $alert.removeClass('is-visible').empty();
  }

  /**
   * Turn a failed jQuery AJAX response into a human-readable message.
   * Handles the backend's {success, message} error envelope, a totally
   * unreachable server (status 0), and anything else as a fallback.
   */
  function getErrorMessage(xhr, fallback) {
    if (xhr.status === 0) {
      return 'Cannot reach the server. Check your connection and try again.';
    }
    if (xhr.responseJSON && xhr.responseJSON.message) {
      return xhr.responseJSON.message;
    }
    return fallback || 'Something went wrong. Please try again.';
  }

  /**
   * Persist the logged-in user (id, name, email — never a password) and
   * their JWT access token locally. The token is what actually protects
   * API requests (see api.js) — the user object is just for UI display.
   */
  function saveSession(user, token) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(user));
    localStorage.setItem(TOKEN_KEY, token);
  }

  function getSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function getToken() {
    return localStorage.getItem(TOKEN_KEY);
  }

  function isAuthenticated() {
    return !!(getSession() && getToken());
  }

  function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(TOKEN_KEY);
  }

  /** "John Doe" -> "JD". Shared by the sidebar, search results, and chat header. */
  function initials(name) {
    return name
      .trim()
      .split(/\s+/)
      .map(function (part) {
        return part[0];
      })
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  $(function () {
    applyBranding();
    renderIcons();
    initTheme();
    initPasswordToggles();
  });

  return {
    isValidEmail: isValidEmail,
    setFieldError: setFieldError,
    showToast: showToast,
    setButtonLoading: setButtonLoading,
    renderIcons: renderIcons,
    showFormAlert: showFormAlert,
    hideFormAlert: hideFormAlert,
    getErrorMessage: getErrorMessage,
    saveSession: saveSession,
    getSession: getSession,
    getToken: getToken,
    isAuthenticated: isAuthenticated,
    clearSession: clearSession,
    initials: initials
  };
})(jQuery);
