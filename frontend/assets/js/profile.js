/**
 * Profile page behavior: auth guard, populating real session data,
 * the user-menu dropdown, logout, and toggling the profile card
 * between view mode and edit mode. Job title / department / employee ID
 * are placeholder fields (no backend support yet) — only name, email and
 * initials come from the real session. Nothing here persists — a
 * cancel restores the last-saved in-memory values.
 */
$(function () {
  if (!Ping.isAuthenticated()) {
    window.location.href = '../auth/login.html';
    return;
  }

  const user = Ping.getSession();

  const $userMenu = $('#userMenu');
  const $editBtn = $('#editBtn');
  const $saveBtn = $('#saveBtn');
  const $cancelBtn = $('#cancelBtn');
  const $viewActions = $('#viewActions');
  const $editActions = $('#editActions');
  const $editableInputs = $('#fullName, #jobTitle, #department');

  // Seed the real, session-backed fields (name, email, initials). Job
  // title / department stay whatever placeholder text is in the markup.
  $('#fullName').val(user.name);
  $('#displayEmail').text(user.email);

  // Snapshot of last-saved values, used to restore the form on cancel.
  let savedValues = {
    fullName: $('#fullName').val(),
    jobTitle: $('#jobTitle').val(),
    department: $('#department').val()
  };

  /** Derive initials (e.g. "John Doe" -> "JD") for the avatar badges. */
  function initialsFor(name) {
    return name
      .trim()
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }

  function refreshDisplay() {
    const fullName = $('#fullName').val().trim();
    const jobTitle = $('#jobTitle').val().trim();
    const department = $('#department').val().trim();

    $('[data-view="fullName"]').text(fullName);
    $('[data-view="jobTitle"]').text(jobTitle);
    $('[data-view="department"]').text(department);

    $('#displayName').text(fullName);
    $('#displayRole').text(jobTitle + ' · ' + department);

    const initials = initialsFor(fullName);
    $('#headerAvatarInitials, #cardAvatarInitials').text(initials);
    $('#headerUserName').text(fullName);
  }

  function enterEditMode() {
    $('.profile-field__value[data-view]').hide();
    $editableInputs.prop('hidden', false);
    $viewActions.hide();
    $editActions.prop('hidden', false);
    $('#fullName').trigger('focus');
  }

  function exitEditMode() {
    $('.profile-field__value[data-view]').show();
    $editableInputs.prop('hidden', true);
    $editActions.prop('hidden', true);
    $viewActions.show();
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
    Ping.setButtonLoading($saveBtn, true);

    setTimeout(function () {
      savedValues = {
        fullName: $('#fullName').val().trim(),
        jobTitle: $('#jobTitle').val().trim(),
        department: $('#department').val().trim()
      };
      refreshDisplay();
      Ping.setButtonLoading($saveBtn, false);
      exitEditMode();
      Ping.showToast('Profile updated successfully.', 'success');
    }, 600);
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

  refreshDisplay();
});
