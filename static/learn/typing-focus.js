export function shouldRestoreTypingFocus({mode, running, finished, resultVisible}) {
  return (mode === 'timed' || mode === 'full')
    && running
    && !finished
    && !resultVisible;
}

export function restoreTypingFocus(input, practiceState) {
  if (!shouldRestoreTypingFocus(practiceState)) return false;
  input.focus({preventScroll: true});
  return true;
}
