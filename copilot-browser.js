/** Small, browser-independent pieces of the Copilot voice pipeline. */
export function createTranscriptCollector() {
  let pieces = [];
  return {
    reset() { pieces = []; },
    consume(event) {
      const results = event?.results || [];
      for (let i = Number(event?.resultIndex) || 0; i < results.length; i++) {
        const alternative = results[i]?.[0];
        if (alternative?.transcript) pieces[i] = { text: alternative.transcript, final: Boolean(results[i].isFinal) };
      }
      const final = pieces.filter(piece => piece?.final).map(piece => piece.text).join(' ').trim();
      const interim = pieces.filter(piece => piece && !piece.final).map(piece => piece.text).join(' ').trim();
      return { final, interim };
    },
    currentFinal() { return pieces.filter(piece => piece?.final).map(piece => piece.text).join(' ').trim(); }
  };
}

/** A single reusable SpeechRecognition instance with one event-listener set. */
export function createSpeechController({ getRecognition, onState = () => {}, onTranscript = () => {}, onError = () => {} }) {
  let recognition = null, listening = false, submitted = false, lastError = false, cancelled = false;
  const collector = createTranscriptCollector();
  const finish = () => {
    const transcript = collector.currentFinal();
    if (transcript && !submitted) { submitted = true; onTranscript(transcript); }
  };
  const ensureRecognition = () => {
    if (recognition) return recognition;
    const Speech = getRecognition();
    if (!Speech) return null;
    recognition = new Speech();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.onstart = () => { listening = true; lastError = false; cancelled = false; onState('LISTENING'); };
    recognition.onresult = event => {
      const result = collector.consume(event);
      if (result.interim) onState('LISTENING', result.interim);
      if (result.final && !submitted) finish();
    };
    recognition.onnomatch = () => { lastError = true; onError('no-speech'); };
    recognition.onerror = event => { listening = false; lastError = true; onError(event?.error || 'unknown'); };
    recognition.onend = () => {
      listening = false;
      const hadFinal = Boolean(collector.currentFinal());
      finish();
      if (!hadFinal && !lastError && !cancelled) onError('no-speech');
      else if (!hadFinal && !lastError) onState('IDLE');
    };
    return recognition;
  };
  return {
    start(language = 'en-US') {
      const instance = ensureRecognition();
      if (!instance) return false;
      if (listening) return true;
      collector.reset(); submitted = false; lastError = false; cancelled = false;
      instance.lang = language;
      try { instance.start(); return true; }
      catch (error) { if (error?.name === 'InvalidStateError') return false; onError(error?.name || 'start-failed'); return false; }
    },
    stop() { if (recognition && listening) { cancelled = true; try { recognition.stop(); } catch {} } },
    get listening() { return listening; },
    get instance() { return recognition; }
  };
}

export function boundedHistory(history, limit = 16) {
  return history.slice(-limit).filter(item => ['user', 'assistant'].includes(item?.role) && typeof item.content === 'string');
}
