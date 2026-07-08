export function fmtOdds(ml) {
  if (ml === null || ml === undefined) return 'n/a';
  return ml > 0 ? `+${ml}` : `${ml}`;
}

export function fmtNum(n, digits = 2) {
  return n === null || n === undefined ? 'n/a' : Number(n).toFixed(digits);
}
