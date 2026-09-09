/**
 * User avatars: renders the initials badge every `.avatar` element already
 * shows (see main.js's Ping.initials), then — if the user has uploaded a
 * photo — swaps in the real image once it's fetched. Every avatar endpoint
 * requires the Authorization header (see routers/users.py's get_avatar), so
 * a plain `<img src>` can't point at it directly; this fetches the bytes as
 * a Blob instead, same reasoning and same blob-URL-cache-by-key pattern as
 * media.js uses for inline message previews.
 *
 * Cached by the FULL avatar_url string (which already embeds a hash of the
 * server-side storage path — see schemas.build_avatar_url) rather than by
 * user id, so replacing a photo naturally changes the cache key and busts
 * any previously-fetched blob with zero manual invalidation logic needed.
 */
const Avatars = (function ($) {
  'use strict';

  // avatarUrl -> { status: 'loading' | 'ready' | 'error', url: string | null }
  const cache = {};
  // avatarUrl -> [onReady, ...] callers still waiting on an in-flight fetch.
  // Several elements can render the SAME avatarUrl in one pass (e.g.
  // profile.js's header-dropdown avatar and profile-card avatar, both fed
  // by the caller's own avatar_url) — every one of them needs to hear back,
  // not just whichever called getEntry() first, otherwise only the first
  // element ever repaints with the fetched image and the rest are stuck
  // showing initials with no poll loop around to retry them.
  const waiters = {};

  function fetchAsBlob(avatarUrl) {
    const token = Ping.getToken();
    return fetch(API_BASE_URL + avatarUrl, {
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    }).then(function (res) {
      if (!res.ok) throw new Error('Avatar fetch failed: ' + res.status);
      return res.blob();
    });
  }

  function getEntry(avatarUrl, onReady) {
    const existing = cache[avatarUrl];
    if (existing && existing.status !== 'loading') return existing;

    if (existing) {
      // Already in flight from an earlier call — just queue behind it.
      if (onReady) (waiters[avatarUrl] = waiters[avatarUrl] || []).push(onReady);
      return existing;
    }

    const loadingEntry = { status: 'loading', url: null };
    cache[avatarUrl] = loadingEntry;
    if (onReady) waiters[avatarUrl] = [onReady];

    fetchAsBlob(avatarUrl)
      .then(function (blob) {
        cache[avatarUrl] = { status: 'ready', url: URL.createObjectURL(blob) };
      })
      .catch(function () {
        cache[avatarUrl] = { status: 'error', url: null };
      })
      .then(function () {
        const callbacks = waiters[avatarUrl] || [];
        delete waiters[avatarUrl];
        callbacks.forEach(function (cb) {
          cb();
        });
      });

    return loadingEntry;
  }

  /**
   * Render into `$el` (any element already carrying the `.avatar` class):
   * initials immediately as the default/fallback, then the real photo once
   * it's fetched, if `avatarUrl` is set. Safe to call repeatedly (a poll
   * tick re-rendering a list, a profile reload) — a cache hit re-renders
   * synchronously with no extra network traffic.
   */
  function apply($el, name, avatarUrl) {
    $el.empty().text(Ping.initials(name || ''));

    if (!avatarUrl) return;

    const entry = getEntry(avatarUrl, function () {
      apply($el, name, avatarUrl); // re-run once the fetch settles (ready or error)
    });

    if (entry.status === 'ready') {
      $el.empty().append($('<img>', { src: entry.url, alt: '' }));
    }
    // 'loading' or 'error' -> the initials set above are left showing.
  }

  return { apply: apply };
})(jQuery);
