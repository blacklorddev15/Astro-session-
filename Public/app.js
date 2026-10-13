(() => {
  const form = document.getElementById('pair-form');
  const phoneInput = document.getElementById('phone-number');
  const consent = document.getElementById('account-consent');
  const startButton = document.getElementById('start-button');
  const panel = document.getElementById('progress-panel');
  const pulseIndicator = panel.querySelector('.pulse');
  const statusMessage = document.getElementById('status-message');
  const progressKicker = document.getElementById('progress-kicker');
  const codeBox = document.getElementById('pairing-code-box');
  const codeOutput = document.getElementById('pairing-code');
  const copyFeedback = document.getElementById('copy-feedback');
  const sessionBox = document.getElementById('session-box');
  const errorBanner = document.getElementById('error-banner');
  const cancelButton = document.getElementById('cancel-button');
  const restartButton = document.getElementById('restart-button');
  let activeRequestId = null;
  let activeAccessToken = null;
  let clientRequestToken = null;
  let clientRequestPhone = null;
  let pollTimer = null;
  let pollFailures = 0;
  let isComplete = false;

  function setError(message) {
    errorBanner.textContent = message;
    errorBanner.classList.remove('hidden');
  }

  function clearError() {
    errorBanner.textContent = '';
    errorBanner.classList.add('hidden');
  }

  function showPanel() {
    panel.classList.remove('hidden');
    form.classList.add('hidden');
  }

  function resetForm() {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
    activeRequestId = null;
    activeAccessToken = null;
    clientRequestToken = null;
    clientRequestPhone = null;
    pollFailures = 0;
    isComplete = false;
    panel.classList.add('hidden');
    form.classList.remove('hidden');
    codeBox.classList.add('hidden');
    sessionBox.classList.add('hidden');
    codeOutput.textContent = '----';
    copyFeedback.textContent = '';
    pulseIndicator.classList.remove('hidden');
    startButton.disabled = false;
    startButton.querySelector('span:first-child').textContent = 'Generate pairing code';
    cancelButton.classList.remove('hidden');
    restartButton.classList.add('hidden');
    clearError();
  }

  async function copyText(value, button, successText) {
    if (!value) return;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(value);
      } else {
        const helper = document.createElement('textarea');
        helper.value = value;
        helper.setAttribute('readonly', '');
        helper.style.position = 'fixed';
        helper.style.opacity = '0';
        document.body.appendChild(helper);
        helper.select();
        const copied = document.execCommand('copy');
        helper.remove();
        if (!copied) throw new Error('Clipboard unavailable');
      }
      const original = button.textContent;
      const originalLabel = button.getAttribute('aria-label');
      button.textContent = successText;
      if (button.id === 'copy-code') button.setAttribute('aria-label', 'Pairing code copied');
      if (button.id === 'copy-code') copyFeedback.textContent = 'Pairing code copied. Paste it into WhatsApp.';
      window.setTimeout(() => {
        button.textContent = original;
        if (originalLabel) button.setAttribute('aria-label', originalLabel);
      }, 1600);
    } catch (_) {
      if (button.id === 'copy-code') copyFeedback.textContent = 'Copy was blocked. Select the pairing code and copy it manually.';
      else setError('Clipboard access was blocked. Select and copy the value manually.');
    }
  }

  function createClientRequestToken() {
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  async function readResponse(response) {
    let body;
    try { body = await response.json(); } catch (_) { body = {}; }
    if (!response.ok) {
      const error = new Error(body.error || 'The request could not be completed.');
      error.status = response.status;
      throw error;
    }
    return body;
  }

  async function pollStatus() {
    if (!activeRequestId) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(activeRequestId)}`, {
        method: 'GET',
        cache: 'no-store',
        headers: { Accept: 'application/json', Authorization: `Bearer ${activeAccessToken}` }
      });
      const data = await readResponse(response);
      pollFailures = 0;
      statusMessage.textContent = data.message || 'Waiting for WhatsApp…';

      if (data.status === 'code_ready') {
        codeOutput.textContent = data.pairingCode || '----';
        codeBox.classList.remove('hidden');
        progressKicker.textContent = 'PAIRING CODE READY';
        cancelButton.classList.remove('hidden');
      } else if (data.status === 'complete') {
        isComplete = true;
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
        progressKicker.textContent = 'PRIVATE DELIVERY COMPLETE';
        pulseIndicator.classList.add('hidden');
        codeBox.classList.add('hidden');
        sessionBox.classList.remove('hidden');
        cancelButton.classList.add('hidden');
        restartButton.classList.remove('hidden');
        return;
      } else if (data.status === 'failed' || data.status === 'cancelled') {
        if (pollTimer) clearTimeout(pollTimer);
        pollTimer = null;
        pulseIndicator.classList.add('hidden');
        cancelButton.classList.add('hidden');
        restartButton.classList.remove('hidden');
        setError(data.message || 'The pairing request ended. Please start again.');
        statusMessage.textContent = 'Request ended';
        return;
      }

      pollTimer = window.setTimeout(pollStatus, 1800);
    } catch (error) {
      if (pollTimer) clearTimeout(pollTimer);
      if (error.status !== 404 && pollFailures < 8) {
        pollFailures += 1;
        statusMessage.textContent = 'Connection interrupted. Reconnecting to your request…';
        cancelButton.classList.remove('hidden');
        pollTimer = window.setTimeout(pollStatus, Math.min(1000 * (2 ** pollFailures), 10000));
      } else {
        pollTimer = null;
        statusMessage.textContent = error.status === 404 ? 'Request expired' : 'Could not reach the session service.';
        setError(error.message || 'Could not reach the session service. Please try again.');
        cancelButton.classList.remove('hidden');
        restartButton.classList.remove('hidden');
      }
    }
  }

  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearError();
    if (!consent.checked) {
      setError('Please confirm you own or are authorized to link this WhatsApp account.');
      consent.focus();
      return;
    }
    const digits = phoneInput.value.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      setError('Enter a valid phone number with country code (7–15 digits).');
      phoneInput.focus();
      return;
    }

    if (!clientRequestToken || clientRequestPhone !== digits) {
      clientRequestToken = createClientRequestToken();
      clientRequestPhone = digits;
    }

    startButton.disabled = true;
    startButton.querySelector('span:first-child').textContent = 'Starting secure pairing…';
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ phoneNumber: digits, clientToken: clientRequestToken })
      });
      const data = await readResponse(response);
      activeRequestId = data.requestId;
      activeAccessToken = clientRequestToken;
      showPanel();
      statusMessage.textContent = 'Connecting securely to WhatsApp…';
      pollStatus();
    } catch (error) {
      startButton.disabled = false;
      startButton.querySelector('span:first-child').textContent = 'Generate pairing code';
      setError(`${error.message || 'Could not start pairing.'} If you retry with the same number, the request can safely resume.`);
    }
  });

  cancelButton.addEventListener('click', async () => {
    if (!activeRequestId) return;
    cancelButton.disabled = true;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(activeRequestId)}`, {
        method: 'DELETE',
        headers: { Accept: 'application/json', Authorization: `Bearer ${activeAccessToken}` }
      });
      await readResponse(response);
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
      statusMessage.textContent = 'Pairing cancelled. Temporary data was removed.';
      codeBox.classList.add('hidden');
      cancelButton.classList.add('hidden');
      restartButton.classList.remove('hidden');
      setError('Pairing cancelled. You can start a new request when ready.');
    } catch (error) {
      setError(error.message || 'Could not cancel pairing.');
    } finally {
      cancelButton.disabled = false;
    }
  });

  restartButton.addEventListener('click', async () => {
    if (activeRequestId) {
      try {
        await fetch(`/api/sessions/${encodeURIComponent(activeRequestId)}`, {
          method: 'DELETE',
          headers: { Accept: 'application/json', Authorization: `Bearer ${activeAccessToken}` }
        });
      } catch (_) {}
    }
    resetForm();
    phoneInput.focus();
  });

  document.getElementById('copy-code').addEventListener('click', event => {
    copyText(codeOutput.textContent.replace(/[^A-Za-z0-9]/g, ''), event.currentTarget, 'Copied');
  });
  phoneInput.addEventListener('input', clearError);
  consent.addEventListener('change', clearError);

  window.addEventListener('pagehide', () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (activeRequestId && activeAccessToken) {
      fetch(`/api/sessions/${encodeURIComponent(activeRequestId)}`, {
        method: 'DELETE',
        keepalive: true,
        headers: { Accept: 'application/json', Authorization: `Bearer ${activeAccessToken}` }
      }).catch(() => {});
    }
    activeAccessToken = null;
  });
})();
