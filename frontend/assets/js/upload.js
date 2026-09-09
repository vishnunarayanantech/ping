/**
 * File sharing: the composer's paperclip button opens the system file
 * picker, then streams the selection to POST /messages/upload with upload
 * progress shown in the bar above the composer. Self-contained — owns the
 * upload-progress bar's DOM and the hidden <input type="file"> (see the
 * markup in dashboard/index.html), same pattern as forward.js owning the
 * forward modal. chat.js calls Upload.init() once at startup; the
 * resulting message is handed back to chat.js via
 * Chat.handleFileUploaded(), which only renders it if the target
 * conversation is still the one open (same filtering Chat.handleForwarded
 * already does for forwarded messages).
 */
const Upload = (function ($) {
  'use strict';

  let $fileInput, $fileBtn, $progress, $progressName, $progressFill;
  let uploading = false;

  function init() {
    $fileInput = $('#fileInput');
    $fileBtn = $('#fileUploadBtn');
    $progress = $('#uploadProgress');
    $progressName = $('#uploadProgressName');
    $progressFill = $('#uploadProgressFill');

    $fileBtn.on('click', function () {
      if (uploading) return;
      $fileInput.trigger('click');
    });

    $fileInput.on('change', function () {
      const file = this.files && this.files[0];
      $fileInput.val(''); // clear now so picking the same file again still fires 'change'
      if (file) startUpload(file);
    });
  }

  function startUpload(file) {
    const conversationId = Chat.getConversationId();
    if (!conversationId || uploading) return;

    const maxBytes = MAX_UPLOAD_SIZE_MB * 1024 * 1024;
    if (file.size > maxBytes) {
      Ping.showToast('That file is larger than the ' + MAX_UPLOAD_SIZE_MB + ' MB limit.', 'error');
      return;
    }
    if (file.size === 0) {
      Ping.showToast('That file is empty.', 'error');
      return;
    }

    const formData = new FormData();
    formData.append('conversation_id', conversationId);
    formData.append('file', file);

    uploading = true;
    $fileBtn.prop('disabled', true);
    showProgress(file.name);

    Api.upload({
      url: '/messages/upload',
      formData: formData,
      onProgress: setProgress
    })
      .done(function (response) {
        Chat.handleFileUploaded(response.message);
        Conversations.refresh();
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return;
        Ping.showToast(Ping.getErrorMessage(xhr, 'Unable to upload file.'), 'error');
      })
      .always(function () {
        uploading = false;
        $fileBtn.prop('disabled', false);
        hideProgress();
      });
  }

  function showProgress(name) {
    $progressName.text(name);
    setProgress(0);
    $progress.prop('hidden', false);
    Ping.renderIcons();
  }

  function setProgress(percent) {
    $progressFill.css('width', percent + '%');
  }

  function hideProgress() {
    $progress.prop('hidden', true);
    $progressFill.css('width', '0%');
  }

  return { init: init };
})(jQuery);
