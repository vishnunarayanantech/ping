/**
 * Reset-password page: live strength meter, requirement checklist,
 * match validation, and a simulated (frontend-only) submit flow.
 */
$(function () {
  const $form = $('#resetForm');
  const $newPassword = $('#newPassword');
  const $confirmPassword = $('#confirmPassword');
  const $resetBtn = $('#resetBtn');
  const $strengthMeter = $('#strengthMeter');
  const $strengthLabel = $('#strengthLabel');
  const $formState = $('#formState');
  const $loadingState = $('#loadingState');
  const $successState = $('#successState');

  const RULES = {
    length: (v) => v.length >= APP_CONFIG.minPasswordLength,
    uppercase: (v) => /[A-Z]/.test(v),
    lowercase: (v) => /[a-z]/.test(v),
    number: (v) => /[0-9]/.test(v)
  };

  function showState($state) {
    $('.auth-card__state').removeClass('is-active');
    $state.addClass('is-active');
  }

  /** Evaluate each requirement rule and toggle its checklist item. */
  function evaluateRequirements(value) {
    const results = {};
    Object.keys(RULES).forEach(function (rule) {
      const met = RULES[rule](value);
      results[rule] = met;
      $('.requirement[data-rule="' + rule + '"]').toggleClass('is-met', met);
    });
    return results;
  }

  /** Update the 4-bar strength meter based on how many rules pass. */
  function updateStrengthMeter(metCount, hasValue) {
    if (!hasValue) {
      $strengthMeter.attr('data-level', '');
      $strengthLabel.text('Password strength');
      return;
    }
    const levels = ['weak', 'weak', 'fair', 'good', 'strong'];
    const level = levels[metCount];
    $strengthMeter.attr('data-level', level);
    $strengthLabel.text(level.charAt(0).toUpperCase() + level.slice(1));
  }

  function validateMatch() {
    if ($confirmPassword.val() === '') {
      Ping.setFieldError($('#confirmPasswordField'));
      return false;
    }
    if ($confirmPassword.val() !== $newPassword.val()) {
      Ping.setFieldError($('#confirmPasswordField'), 'Passwords do not match.');
      return false;
    }
    Ping.setFieldError($('#confirmPasswordField'));
    return true;
  }

  function updateSubmitState() {
    const value = $newPassword.val();
    const results = evaluateRequirements(value);
    const metCount = Object.values(results).filter(Boolean).length;
    updateStrengthMeter(metCount, value.length > 0);

    const allRulesMet = Object.values(results).every(Boolean);
    const passwordsMatch = $confirmPassword.val() !== '' && $confirmPassword.val() === value;

    $resetBtn.prop('disabled', !(allRulesMet && passwordsMatch));
    return allRulesMet;
  }

  $newPassword.on('input', updateSubmitState);
  $confirmPassword.on('input', function () {
    updateSubmitState();
    if ($confirmPassword.val() !== '') validateMatch();
  });

  $form.on('submit', function (e) {
    e.preventDefault();

    const allRulesMet = updateSubmitState();
    if (!allRulesMet) {
      Ping.setFieldError($('#newPasswordField'), 'Password does not meet all requirements.');
      return;
    }
    Ping.setFieldError($('#newPasswordField'));

    if (!validateMatch()) return;

    showState($loadingState);

    setTimeout(function () {
      showState($successState);
    }, APP_CONFIG.simulatedNetworkDelay);
  });

  showState($formState);
});
