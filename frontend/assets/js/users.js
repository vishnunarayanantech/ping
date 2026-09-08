/**
 * Sidebar user search: debounced input, dynamic results, click-to-select.
 * Self-contained — owns the results dropdown's DOM. dashboard.js just calls
 * init() once with an onSelect callback for when a result is clicked.
 */
const Users = (function ($) {
  'use strict';

  const DEBOUNCE_MS = 300;
  const MIN_QUERY_LENGTH = 2;

  let debounceTimer = null;
  let requestSeq = 0;

  function init($input, $results, onSelect) {
    $input.on('input', function () {
      const query = $input.val().trim();
      clearTimeout(debounceTimer);

      if (query.length < MIN_QUERY_LENGTH) {
        requestSeq++; // invalidate any in-flight request's response
        hide($results);
        return;
      }

      debounceTimer = setTimeout(function () {
        runSearch(query, $results, onSelect);
      }, DEBOUNCE_MS);
    });
  }

  function runSearch(query, $results, onSelect) {
    const seq = ++requestSeq;
    renderLoading($results);

    Api.request({ url: '/users/search?q=' + encodeURIComponent(query) })
      .done(function (response) {
        if (seq !== requestSeq) return; // a newer search superseded this one
        renderResults(response.users, $results, onSelect);
      })
      .fail(function (xhr) {
        if (seq !== requestSeq) return;
        if (xhr.status === 401) return; // api.js is already redirecting to login
        renderError($results, Ping.getErrorMessage(xhr, 'Search failed. Please try again.'));
      });
  }

  function renderLoading($results) {
    $results.empty();
    $('<div>', { class: 'search-status' }).text('Searching…').appendTo($results);
    $results.prop('hidden', false);
  }

  function renderError($results, message) {
    $results.empty();
    $('<div>', { class: 'search-status search-status--error' }).text(message).appendTo($results);
    $results.prop('hidden', false);
  }

  function renderResults(users, $results, onSelect) {
    $results.empty();

    if (users.length === 0) {
      $('<div>', { class: 'search-status' }).text('No people found matching your search.').appendTo($results);
      $results.prop('hidden', false);
      return;
    }

    users.forEach(function (user) {
      const $item = $('<button>', { type: 'button', class: 'search-result' });
      $('<span>', { class: 'avatar avatar--sm' }).text(Ping.initials(user.name)).appendTo($item);

      const $info = $('<span>', { class: 'search-result__info' });
      $('<span>', { class: 'search-result__name' }).text(user.name).appendTo($info);
      $('<span>', { class: 'search-result__email' }).text(user.email).appendTo($info);
      $info.appendTo($item);

      $item.on('click', function () {
        hide($results);
        onSelect(user);
      });

      $results.append($item);
    });

    $results.prop('hidden', false);
  }

  function hide($results) {
    $results.empty().prop('hidden', true);
  }

  return { init: init };
})(jQuery);
