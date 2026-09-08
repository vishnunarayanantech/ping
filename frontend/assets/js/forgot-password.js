/**
 * Forgot-password page: validates the email, then walks the UI through
 * form -> loading -> success states. No request is ever actually sent.
 */
$(function () {
  const $form = $('#forgotForm');
  const $email = $('#email');
  const $formState = $('#formState');
  const $loadingState = $('#loadingState');
  const $successState = $('#successState');

  function showState($state) {
    $('.auth-card__state').removeClass('is-active');
    $state.addClass('is-active');
  }

  $form.on('submit', function (e) {
    e.preventDefault();

    if ($email.val().trim() === '') {
      Ping.setFieldError($('#emailField'), 'Company email is required.');
      return;
    }
    if (!Ping.isValidEmail($email.val())) {
      Ping.setFieldError($('#emailField'), 'Enter a valid email address.');
      return;
    }
    Ping.setFieldError($('#emailField'));

    showState($loadingState);

    setTimeout(function () {
      showState($successState);
    }, APP_CONFIG.simulatedNetworkDelay);
  });

  showState($formState);
});
