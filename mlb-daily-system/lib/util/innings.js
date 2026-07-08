// MLB reports innings pitched with a dot notation where the fractional part
// is outs, not tenths (".1" = one out = 1/3 inning, ".2" = two outs = 2/3
// inning). This converts that notation to true outs so partial innings can
// be summed exactly before being turned back into a decimal for storage.
export function ipStringToOuts(ipString) {
  if (ipString === null || ipString === undefined || ipString === '') return 0;
  const value = typeof ipString === 'number' ? ipString : parseFloat(ipString);
  if (Number.isNaN(value)) return 0;
  const whole = Math.trunc(value);
  const frac = Math.round((Math.abs(value) - Math.abs(whole)) * 10);
  const partialOuts = frac === 1 ? 1 : frac === 2 ? 2 : 0;
  return whole * 3 + Math.sign(value || 1) * partialOuts;
}

export function outsToDecimalInnings(outs) {
  return outs / 3;
}
