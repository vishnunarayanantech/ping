/**
 * Inline media previews (images/video/audio) for file-share messages, plus
 * the image lightbox. Owns a blob-URL cache keyed by file id — chat.js's
 * poll-driven renderMessages() fully re-renders the message list every 5s
 * (and on every send/reaction/reply), so without a cache every tick would
 * silently re-fetch and re-decode every visible image/video/audio from
 * scratch. Self-contained, same module-per-concern pattern as forward.js /
 * upload.js. chat.js calls Media.init() once at startup and
 * Media.getPreview(fileId, onReady) from renderMessageRow, then
 * Media.markError(fileId) if the browser itself fails to decode bytes that
 * did fetch successfully (corrupt file, unsupported codec).
 */
const Media = (function ($) {
  'use strict';

  // fileId -> { status: 'loading' | 'ready' | 'error', url: string | null }
  const cache = {};

  let $lightbox, $lightboxImg;

  function init() {
    $lightbox = $('#imageLightboxOverlay');
    $lightboxImg = $('#imageLightboxImg');

    $('#imageLightboxClose').on('click', closeLightbox);
    // Click on the dimmed backdrop (not the image itself) closes it, same
    // convention as the forward modal.
    $lightbox.on('click', function (e) {
      if (e.target === $lightbox[0]) closeLightbox();
    });
    $(document).on('keydown', function (e) {
      if (e.key === 'Escape' && !$lightbox.prop('hidden')) closeLightbox();
    });
  }

  /**
   * Fetch a file's bytes as a Blob via an authenticated request — a plain
   * <a href>/<img src> can't carry the Authorization header the download
   * endpoint requires, so every consumer (download, inline preview) goes
   * through this rather than pointing an element straight at the API URL.
   */
  function fetchAsBlob(fileId) {
    const token = Ping.getToken();
    return fetch(API_BASE_URL + '/messages/files/' + fileId + '/download', {
      headers: token ? { Authorization: 'Bearer ' + token } : {}
    }).then(function (res) {
      if (!res.ok) throw new Error('Fetch failed: ' + res.status);
      return res.blob();
    });
  }

  /**
   * Synchronously returns the cached preview state for `fileId`
   * ({status, url}), kicking off a fetch the first time it's asked for.
   * `onReady` fires once, when a 'loading' entry settles into 'ready' or
   * 'error' — never called again once a file has settled, so repeated
   * renders (poll ticks, a reaction click elsewhere in the same
   * conversation) are pure cache reads with no network traffic.
   */
  function getPreview(fileId, onReady) {
    const existing = cache[fileId];
    if (existing) return existing;

    const loadingEntry = { status: 'loading', url: null };
    cache[fileId] = loadingEntry;

    fetchAsBlob(fileId)
      .then(function (blob) {
        cache[fileId] = { status: 'ready', url: URL.createObjectURL(blob) };
      })
      .catch(function () {
        cache[fileId] = { status: 'error', url: null };
      })
      .then(function () {
        if (onReady) onReady();
      });

    return loadingEntry;
  }

  /**
   * Force a file's cache entry into 'error' — called when the bytes
   * fetched fine but the browser couldn't decode them as the claimed media
   * type (a <video>/<img>/<audio> `error` event). Makes the fallback to
   * the plain file card sticky: without this, the next re-render (a poll
   * tick 5s later) would see no cache entry... actually it WOULD still see
   * the 'ready' entry from the successful fetch and retry the same
   * doomed-to-fail element every time. Revokes the now-useless object URL;
   * download still works independently via its own fetchAsBlob() call.
   */
  function markError(fileId) {
    const existing = cache[fileId];
    if (existing && existing.url) {
      URL.revokeObjectURL(existing.url);
    }
    cache[fileId] = { status: 'error', url: null };
  }

  function openLightbox(url, filename) {
    $lightboxImg.attr('src', url).attr('alt', filename || '');
    $lightbox.prop('hidden', false);
    Ping.renderIcons();
  }

  function closeLightbox() {
    $lightbox.prop('hidden', true);
    $lightboxImg.attr('src', '');
  }

  return {
    init: init,
    fetchAsBlob: fetchAsBlob,
    getPreview: getPreview,
    markError: markError,
    openLightbox: openLightbox
  };
})(jQuery);
