/**
 * Profile page behavior: auth guard, loading/saving the real profile
 * through the backend API (GET/PUT /users/profile), the user-menu
 * dropdown, logout, toggling the profile card between view mode and edit
 * mode, and avatar upload (pick -> local preview -> explicit save/cancel,
 * via POST /users/profile/avatar). Full name / job title / department /
 * avatar are editable and persist to the database; company email /
 * employee ID are always read-only.
 */
$(function () {
  if (!Ping.isAuthenticated()) {
    window.location.href = '../auth/login.html';
    return;
  }

  const sessionUser = Ping.getSession();

  const $editBtn = $('#editBtn');
  const $saveBtn = $('#saveBtn');
  const $cancelBtn = $('#cancelBtn');
  const $viewActions = $('#viewActions');
  const $editActions = $('#editActions');
  const $editableInputs = $('#fullName, #jobTitle, #department');
  const $userMenu = $('#userMenu');

  const $avatarWrap = $('#profileAvatarWrap');
  const $avatarEditBtn = $('#avatarEditBtn');
  const $avatarFileInput = $('#avatarFileInput');
  const $avatarPending = $('#avatarPending');
  const $avatarCancelBtn = $('#avatarCancelBtn');
  const $avatarSaveBtn = $('#avatarSaveBtn');
  const $cardAvatar = $('#cardAvatarInitials');
  const $headerAvatar = $('#headerAvatarInitials');

  const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  // Local-preview state for an avatar the user picked but hasn't saved yet.
  let pendingAvatarFile = null;
  let pendingPreviewUrl = null;
  let currentAvatarUrl = null; // last-saved avatar_url from the backend, or null

  // Seed from the cached session immediately so the page isn't blank while
  // the authoritative GET /users/profile request (below) is in flight.
  $('#fullName').val(sessionUser.name);
  $('#displayEmail').text(sessionUser.email);
  refreshDisplay();
  renderSavedAvatar(sessionUser.avatar_url || null);

  // Snapshot of last-saved values, used to restore the form on cancel.
  let savedValues = {
    fullName: $('#fullName').val(),
    jobTitle: $('#jobTitle').val(),
    department: $('#department').val()
  };

  function refreshDisplay() {
    const fullName = $('#fullName').val().trim();
    const jobTitle = $('#jobTitle').val().trim();
    const department = $('#department').val().trim();

    $('[data-view="fullName"]').text(fullName);
    $('[data-view="jobTitle"]').text(jobTitle);
    $('[data-view="department"]').text(department);

    $('#displayName').text(fullName);
    $('#displayRole').text([jobTitle, department].filter(Boolean).join(' · '));

    $('#headerUserName').text(fullName);
  }

  /** Render the last-saved avatar (or the initials fallback) into both the
   * header dropdown trigger and the profile card. Used on load, after any
   * profile/avatar fetch or save, and when an unsaved preview is
   * cancelled — always reflects what's actually persisted, never a
   * mid-edit local preview (see stageAvatar for that). */
  function renderSavedAvatar(avatarUrl) {
    currentAvatarUrl = avatarUrl;
    const fullName = $('#fullName').val().trim();
    Avatars.apply($cardAvatar, fullName, avatarUrl);
    Avatars.apply($headerAvatar, fullName, avatarUrl);
  }

  /** Apply a profile object ({full_name, job_title, department,
   * company_email, employee_id, avatar_url}) fetched/returned by the
   * backend and make it the new "last saved" snapshot. */
  function applyProfile(profile) {
    $('#fullName').val(profile.full_name);
    $('#jobTitle').val(profile.job_title);
    $('#department').val(profile.department);
    $('#displayEmail').text(profile.company_email);
    $('#displayEmployeeId').text(profile.employee_id);

    savedValues = {
      fullName: profile.full_name,
      jobTitle: profile.job_title,
      department: profile.department
    };

    refreshDisplay();
    renderSavedAvatar(profile.avatar_url || null);

    // Keep the cached session in sync so other pages (dashboard.js/main.js
    // read Ping.getSession() on load for the sidebar name/avatar) reflect
    // the change without requiring a fresh login.
    Ping.saveSession(
      $.extend({}, Ping.getSession(), { name: profile.full_name, avatar_url: profile.avatar_url }),
      Ping.getToken()
    );
  }

  function loadProfile() {
    Api.request({ url: '/users/profile' })
      .done(function (response) {
        applyProfile(response.profile);
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return; // api.js is already redirecting to login
        Ping.showToast(Ping.getErrorMessage(xhr, 'Could not load your profile.'), 'error');
      });
  }

  function enterEditMode() {
    $('.profile-field__value[data-view]').hide();
    $editableInputs.prop('hidden', false);
    $viewActions.hide();
    $editActions.prop('hidden', false);
    $avatarEditBtn.prop('hidden', false);
    $('#fullName').trigger('focus');
  }

  function exitEditMode() {
    $('.profile-field__value[data-view]').show();
    $editableInputs.prop('hidden', true);
    $editActions.prop('hidden', true);
    $viewActions.show();
    $avatarEditBtn.prop('hidden', true);
    cancelAvatarChange(); // discard any unsaved photo selection along with the rest of the form
  }

  $editBtn.on('click', enterEditMode);

  $cancelBtn.on('click', function () {
    $('#fullName').val(savedValues.fullName);
    $('#jobTitle').val(savedValues.jobTitle);
    $('#department').val(savedValues.department);
    refreshDisplay();
    exitEditMode();
  });

  $saveBtn.on('click', function () {
    const fullName = $('#fullName').val().trim();
    const jobTitle = $('#jobTitle').val().trim();
    const department = $('#department').val().trim();

    if (fullName.length < 2) {
      Ping.showToast('Full name must be at least 2 characters.', 'error');
      return;
    }

    Ping.setButtonLoading($saveBtn, true);

    Api.request({
      url: '/users/profile',
      method: 'PUT',
      data: { full_name: fullName, job_title: jobTitle, department: department }
    })
      .done(function (response) {
        applyProfile(response.profile);
        exitEditMode();
        Ping.showToast('Profile updated successfully.', 'success');
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return; // api.js is already redirecting to login
        Ping.showToast(Ping.getErrorMessage(xhr, 'Could not update your profile.'), 'error');
      })
      .always(function () {
        Ping.setButtonLoading($saveBtn, false);
      });
  });

  // --- Avatar upload: pick -> local preview -> explicit save/cancel -----

  $avatarEditBtn.on('click', function () {
    $avatarFileInput.trigger('click');
  });

  $avatarFileInput.on('change', function () {
    const file = this.files && this.files[0];
    $avatarFileInput.val(''); // clear now so picking the same file again still fires 'change'
    if (file) stageAvatar(file);
  });

  /** Client-side checks are purely a fast pre-flight (the backend
   * independently decodes and validates the real bytes — see
   * services/avatar_service.py) — then an instant local preview via
   * a blob: URL, no network request yet. */
  function stageAvatar(file) {
    if (ALLOWED_AVATAR_TYPES.indexOf(file.type) === -1) {
      Ping.showToast('Please choose a JPG, PNG, or WebP image.', 'error');
      return;
    }
    if (file.size === 0) {
      Ping.showToast('That image is empty.', 'error');
      return;
    }
    if (file.size > MAX_AVATAR_SIZE_MB * 1024 * 1024) {
      Ping.showToast('That image is larger than the ' + MAX_AVATAR_SIZE_MB + ' MB limit.', 'error');
      return;
    }

    revokePendingPreview();
    pendingAvatarFile = file;
    pendingPreviewUrl = URL.createObjectURL(file);

    $cardAvatar.empty().append($('<img>', { src: pendingPreviewUrl, alt: '' }));
    $avatarPending.prop('hidden', false);
  }

  function revokePendingPreview() {
    if (pendingPreviewUrl) {
      URL.revokeObjectURL(pendingPreviewUrl);
      pendingPreviewUrl = null;
    }
  }

  function cancelAvatarChange() {
    if (!pendingAvatarFile) return;
    pendingAvatarFile = null;
    revokePendingPreview();
    $avatarPending.prop('hidden', true);
    renderSavedAvatar(currentAvatarUrl); // restore whatever's actually saved (or initials)
  }

  $avatarCancelBtn.on('click', cancelAvatarChange);

  $avatarSaveBtn.on('click', function () {
    if (!pendingAvatarFile) return;

    const formData = new FormData();
    formData.append('file', pendingAvatarFile);

    Ping.setButtonLoading($avatarSaveBtn, true);
    $avatarWrap.addClass('profile-avatar--busy');
    $avatarEditBtn.prop('disabled', true);

    Api.upload({ url: '/users/profile/avatar', formData: formData })
      .done(function (response) {
        pendingAvatarFile = null;
        revokePendingPreview();
        $avatarPending.prop('hidden', true);
        // Refreshes the card/header avatar from the new backend URL and
        // syncs the cached session — same "update everywhere" path a
        // name/job/department save already goes through.
        applyProfile(response.profile);
        Ping.showToast('Avatar updated successfully.', 'success');
      })
      .fail(function (xhr) {
        if (xhr.status === 401) return; // api.js is already redirecting to login
        Ping.showToast(Ping.getErrorMessage(xhr, 'Could not update your avatar.'), 'error');
      })
      .always(function () {
        Ping.setButtonLoading($avatarSaveBtn, false);
        $avatarWrap.removeClass('profile-avatar--busy');
        $avatarEditBtn.prop('disabled', false);
      });
  });

  // User menu dropdown: toggle on click, close on outside click / Escape.
  $('#userMenuTrigger').on('click', function (e) {
    e.stopPropagation();
    const isOpen = $userMenu.toggleClass('is-open').hasClass('is-open');
    $(this).attr('aria-expanded', isOpen);
  });

  $(document).on('click', function () {
    $userMenu.removeClass('is-open');
    $('#userMenuTrigger').attr('aria-expanded', 'false');
  });

  $(document).on('keydown', function (e) {
    if (e.key === 'Escape') {
      $userMenu.removeClass('is-open');
      $('#userMenuTrigger').attr('aria-expanded', 'false');
    }
  });

  $('#logoutLink').on('click', function (e) {
    e.preventDefault();
    Ping.clearSession();
    window.location.href = '../auth/login.html';
  });

  loadProfile();
});
