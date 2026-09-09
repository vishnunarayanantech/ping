/**
 * Reusable AJAX helper for authenticated API calls. Every feature module
 * (users.js, chat.js) goes through this instead of calling $.ajax directly,
 * so JWT attachment and session-expiry handling live in exactly one place.
 */
const Api = (function ($) {
  'use strict';

  /**
   * @param {Object} options
   * @param {string} options.url - path relative to API_BASE_URL, e.g. '/messages'
   * @param {string} [options.method] - defaults to 'GET'
   * @param {Object} [options.data] - JSON body
   * @returns {jqXHR}
   */
  function request(options) {
    const token = Ping.getToken();
    const headers = {};
    if (token) {
      headers.Authorization = 'Bearer ' + token;
    }

    return $.ajax({
      url: API_BASE_URL + options.url,
      method: options.method || 'GET',
      contentType: options.data ? 'application/json' : undefined,
      data: options.data ? JSON.stringify(options.data) : undefined,
      headers: headers
    }).fail(function (xhr) {
      if (xhr.status === 401) {
        // Token missing/invalid/expired — nothing to do but start over.
        Ping.clearSession();
        window.location.href = '../auth/login.html';
      }
    });
  }

  /**
   * Multipart form upload (file sharing) — kept separate from request()
   * because a FormData body needs contentType/processData disabled (jQuery
   * would otherwise try to JSON-stringify or urlencode it) and because
   * upload progress only exists as an xhr-level event jQuery doesn't
   * surface any other way.
   * @param {Object} options
   * @param {string} options.url - path relative to API_BASE_URL
   * @param {FormData} options.formData
   * @param {function(number)} [options.onProgress] - called with 0-100
   * @returns {jqXHR}
   */
  function upload(options) {
    const token = Ping.getToken();
    const headers = {};
    if (token) {
      headers.Authorization = 'Bearer ' + token;
    }

    return $.ajax({
      url: API_BASE_URL + options.url,
      method: 'POST',
      data: options.formData,
      headers: headers,
      contentType: false,
      processData: false,
      xhr: function () {
        const xhr = $.ajaxSettings.xhr();
        if (xhr.upload && options.onProgress) {
          xhr.upload.addEventListener('progress', function (e) {
            if (e.lengthComputable) {
              options.onProgress(Math.round((e.loaded / e.total) * 100));
            }
          });
        }
        return xhr;
      }
    }).fail(function (xhr) {
      if (xhr.status === 401) {
        Ping.clearSession();
        window.location.href = '../auth/login.html';
      }
    });
  }

  return { request: request, upload: upload };
})(jQuery);
