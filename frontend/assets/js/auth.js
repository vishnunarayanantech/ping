/**
 * Auth page behavior: login and registration, both talking to the real
 * backend API. Each initializer no-ops if its form isn't on the current
 * page, so login.html and register.html can share this one file.
 */
$(function () {
  initLoginForm();
  initRegisterForm();
});

function initLoginForm() {
  const $form = $('#loginForm');
  if (!$form.length) return;

  const $email = $('#email');
  const $password = $('#password');
  const $loginBtn = $('#loginBtn');
  const $alert = $('#formAlert');

  function updateSubmitState() {
    $loginBtn.prop('disabled', $email.val().trim() === '' || $password.val().trim() === '');
  }

  function validate() {
    let valid = true;

    if ($email.val().trim() === '') {
      Ping.setFieldError($('#emailField'), 'Company email is required.');
      valid = false;
    } else if (!Ping.isValidEmail($email.val())) {
      Ping.setFieldError($('#emailField'), 'Enter a valid email address.');
      valid = false;
    } else {
      Ping.setFieldError($('#emailField'));
    }

    if ($password.val() === '') {
      Ping.setFieldError($('#passwordField'), 'Password is required.');
      valid = false;
    } else {
      Ping.setFieldError($('#passwordField'));
    }

    return valid;
  }

  $email.add($password).on('input', updateSubmitState);

  $form.on('submit', function (e) {
    e.preventDefault();
    Ping.hideFormAlert($alert);
    if (!validate()) return;

    Ping.setButtonLoading($loginBtn, true);

    $.ajax({
      url: API_BASE_URL + '/auth/login',
      method: 'POST',
      contentType: 'application/json',
      data: JSON.stringify({
        email: $email.val().trim(),
        password: $password.val()
      })
    })
      .done(function (response) {
        Ping.saveSession(response.user, response.access_token);
        Ping.showToast('Login successful. Redirecting…', 'success');
        setTimeout(function () {
          window.location.href = '../dashboard/index.html';
        }, 500);
      })
      .fail(function (xhr) {
        Ping.setButtonLoading($loginBtn, false);
        Ping.showFormAlert($alert, Ping.getErrorMessage(xhr, 'Invalid email or password.'));
      });
  });

  updateSubmitState();
}

function initRegisterForm() {
  const $form = $('#registerForm');
  if (!$form.length) return;

  const $name = $('#name');
  const $email = $('#email');
  const $password = $('#password');
  const $confirmPassword = $('#confirmPassword');
  const $registerBtn = $('#registerBtn');
  const $alert = $('#formAlert');

  function updateSubmitState() {
    const filled =
      $name.val().trim() !== '' &&
      $email.val().trim() !== '' &&
      $password.val() !== '' &&
      $confirmPassword.val() !== '';
    $registerBtn.prop('disabled', !filled);
  }

  function validate() {
    let valid = true;

    if ($name.val().trim() === '') {
      Ping.setFieldError($('#nameField'), 'Full name is required.');
      valid = false;
    } else if ($name.val().trim().length < 2) {
      Ping.setFieldError($('#nameField'), 'Name must be at least 2 characters.');
      valid = false;
    } else {
      Ping.setFieldError($('#nameField'));
    }

    if ($email.val().trim() === '') {
      Ping.setFieldError($('#emailField'), 'Company email is required.');
      valid = false;
    } else if (!Ping.isValidEmail($email.val())) {
      Ping.setFieldError($('#emailField'), 'Enter a valid email address.');
      valid = false;
    } else {
      Ping.setFieldError($('#emailField'));
    }

    if ($password.val() === '') {
      Ping.setFieldError($('#passwordField'), 'Password is required.');
      valid = false;
    } else if ($password.val().length < APP_CONFIG.minPasswordLength) {
      Ping.setFieldError($('#passwordField'), 'Password must be at least ' + APP_CONFIG.minPasswordLength + ' characters.');
      valid = false;
    } else {
      Ping.setFieldError($('#passwordField'));
    }

    if ($confirmPassword.val() === '') {
      Ping.setFieldError($('#confirmPasswordField'), 'Please confirm your password.');
      valid = false;
    } else if ($confirmPassword.val() !== $password.val()) {
      Ping.setFieldError($('#confirmPasswordField'), 'Passwords do not match.');
      valid = false;
    } else {
      Ping.setFieldError($('#confirmPasswordField'));
    }

    return valid;
  }

  $name.add($email).add($password).add($confirmPassword).on('input', updateSubmitState);

  $form.on('submit', function (e) {
    e.preventDefault();
    Ping.hideFormAlert($alert);
    if (!validate()) return;

    Ping.setButtonLoading($registerBtn, true);

    $.ajax({
      url: API_BASE_URL + '/auth/register',
      method: 'POST',
      contentType: 'application/json',
      data: JSON.stringify({
        name: $name.val().trim(),
        email: $email.val().trim(),
        password: $password.val()
      })
    })
      .done(function () {
        Ping.showToast('Account created. Redirecting to login…', 'success');
        setTimeout(function () {
          window.location.href = 'login.html';
        }, 900);
      })
      .fail(function (xhr) {
        Ping.setButtonLoading($registerBtn, false);
        Ping.showFormAlert($alert, Ping.getErrorMessage(xhr, 'Registration failed. Please try again.'));
      });
  });

  updateSubmitState();
}
